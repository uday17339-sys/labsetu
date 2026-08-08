import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { TenantKeyService } from '../../common/crypto/tenant-key.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * The critical-value callback log.
 *
 * A potassium of 7.2 flagged on a screen helps nobody at 2am. NABL 112 and
 * ISO 15189 §7.4.1 require the lab to notify the requesting clinician
 * immediately and to hold *evidence* of that notification — who was told, by
 * whom, at what time, and what they read back.
 *
 * The flag was already being raised; the phone call had nowhere to be recorded.
 * That is the gap this closes, and it is the single most commonly cited
 * non-conformance in Indian NABL assessments.
 *
 * Read-back is mandatory, not decorative: repeating the value and the patient
 * identity back to the lab is what catches "I thought you said seven-point-two
 * for the patient in bed 4".
 */
@Injectable()
export class CriticalValuesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly tenantKeys: TenantKeyService,
  ) {}

  /**
   * Outstanding critical values — flagged, current, and not yet called through.
   *
   * This is a worklist, so it is ordered oldest first. The longest-waiting call
   * is the one that matters.
   */
  async pending(includeNotified = false) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const results = await tx.result.findMany({
      where: {
        isCritical: true,
        isCurrent: true,
        ...(includeNotified ? {} : { criticalNotifiedAt: null }),
      },
      orderBy: { enteredAt: 'asc' },
      take: 200,
      include: {
        analyte: { select: { code: true, name: true, defaultUnit: true } },
        sampleTest: {
          select: {
            id: true,
            status: true,
            testDefinition: { select: { code: true, name: true } },
            sample: {
              select: {
                accessionNumber: true,
                collectedAt: true,
                patient: {
                  select: {
                    id: true,
                    patientCode: true,
                    sex: true,
                    ageYears: true,
                    nameEnc: true,
                    dataKeyEnc: true,
                    erasedAt: true,
                  },
                },
                order: {
                  select: {
                    orderNumber: true,
                    referringDoctor: { select: { name: true, phone: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (results.length === 0) return { items: [], count: 0 };

    // Naming the patient is the point of the call, so PII is decrypted here —
    // and the access is audited like every other PHI read.
    const tenantKey = await this.tenantKeys.get(ctx.tenantId!);
    const names = new Map<string, string | null>();
    for (const r of results) {
      const p = r.sampleTest.sample.patient;
      if (!p || p.erasedAt || names.has(p.id)) continue;
      const key = this.crypto.unwrapSubjectKey(p.dataKeyEnc, tenantKey);
      names.set(p.id, this.crypto.decryptField(p.nameEnc, key));
    }

    if (names.size > 0) {
      await this.audit.record(tx, {
        action: 'READ_SENSITIVE',
        entityType: 'Patient',
        entityId: null,
        after: { view: 'CRITICAL_CALLBACK_WORKLIST', patientCount: names.size },
      });
    }

    const now = Date.now();
    return {
      count: results.length,
      items: results.map((r) => {
        const s = r.sampleTest.sample;
        return {
          resultId: r.id,
          sampleTestId: r.sampleTest.id,
          accessionNumber: s.accessionNumber,
          orderNumber: s.order?.orderNumber ?? null,
          patientCode: s.patient?.patientCode ?? null,
          patientName: s.patient ? (names.get(s.patient.id) ?? null) : null,
          sex: s.patient?.sex ?? null,
          ageYears: s.patient?.ageYears ?? null,
          test: r.sampleTest.testDefinition.code,
          testName: r.sampleTest.testDefinition.name,
          analyte: r.analyte.code,
          analyteName: r.analyte.name,
          value: r.value,
          unit: r.unit ?? r.analyte.defaultUnit,
          flag: r.flag,
          refLow: r.refLow?.toNumber() ?? null,
          refHigh: r.refHigh?.toNumber() ?? null,
          enteredAt: r.enteredAt.toISOString(),
          /// Minutes outstanding — the number an assessor asks about.
          waitingMinutes: Math.round((now - r.enteredAt.getTime()) / 60000),
          referringDoctor: s.order?.referringDoctor?.name ?? null,
          referringDoctorPhone: s.order?.referringDoctor?.phone ?? null,
          notifiedAt: r.criticalNotifiedAt?.toISOString() ?? null,
          notifiedTo: r.criticalNotifiedTo,
        };
      }),
    };
  }

  /**
   * Records that the clinician was told.
   *
   * `readBack` is required. A callback without read-back confirmation is not
   * evidence that the right value reached the right patient's clinician, and
   * recording it as though it were would make the log worse than useless during
   * an assessment.
   */
  async recordCallback(
    resultId: string,
    input: { notifiedTo: string; method: string; readBack: string; note?: string },
  ) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const result = await tx.result.findUnique({
      where: { id: resultId },
      include: {
        analyte: { select: { code: true, name: true } },
        sampleTest: {
          select: {
            testDefinition: { select: { code: true } },
            sample: {
              select: {
                accessionNumber: true,
                patient: { select: { patientCode: true } },
              },
            },
          },
        },
      },
    });
    if (!result) throw new NotFoundException('Result not found');

    if (!result.isCritical) {
      throw new BadRequestException(
        'This result is not flagged critical. Logging a callback against a normal result ' +
          'would put noise into the record an assessor reads as evidence.',
      );
    }
    if (!result.isCurrent) {
      throw new BadRequestException(
        'This is a superseded version of the result. Call back against the current value.',
      );
    }
    if (result.criticalNotifiedAt) {
      throw new BadRequestException(
        `A callback was already recorded at ${result.criticalNotifiedAt.toISOString()} to ` +
          `${result.criticalNotifiedTo}. The log is append-only; add a comment if a second ` +
          `call was needed.`,
      );
    }

    const notifiedAt = new Date();
    await tx.result.update({
      where: { id: resultId },
      data: {
        criticalNotifiedAt: notifiedAt,
        criticalNotifiedBy: ctx.userId,
        criticalNotifiedTo: input.notifiedTo.trim(),
        comment: [result.comment, `Critical value called to ${input.notifiedTo.trim()} via ${input.method}. Read-back: "${input.readBack.trim()}".${input.note ? ` ${input.note.trim()}` : ''}`]
          .filter(Boolean)
          .join(' | '),
      },
    });

    const waitingMinutes = Math.round(
      (notifiedAt.getTime() - result.enteredAt.getTime()) / 60000,
    );

    await this.audit.record(tx, {
      action: 'CRITICAL_VALUE_NOTIFIED',
      entityType: 'Result',
      entityId: resultId,
      after: {
        event: 'CRITICAL_VALUE_CALLBACK',
        accessionNumber: result.sampleTest.sample.accessionNumber,
        patientCode: result.sampleTest.sample.patient?.patientCode ?? null,
        test: result.sampleTest.testDefinition.code,
        analyte: result.analyte.code,
        value: result.value,
        notifiedTo: input.notifiedTo.trim(),
        method: input.method,
        readBack: input.readBack.trim(),
        note: input.note?.trim() ?? null,
        notifiedAt: notifiedAt.toISOString(),
        minutesFromResultToCall: waitingMinutes,
      },
    });

    return {
      resultId,
      notifiedAt: notifiedAt.toISOString(),
      notifiedTo: input.notifiedTo.trim(),
      minutesFromResultToCall: waitingMinutes,
    };
  }

  /**
   * The NABL quality indicator: what fraction of critical values were called
   * through, and how quickly.
   */
  async performance(from: Date, to: Date) {
    const results = await this.prisma.tx.result.findMany({
      where: { isCritical: true, isCurrent: true, enteredAt: { gte: from, lte: to } },
      select: { enteredAt: true, criticalNotifiedAt: true },
    });

    const notified = results.filter((r) => r.criticalNotifiedAt);
    const minutes = notified
      .map((r) => (r.criticalNotifiedAt!.getTime() - r.enteredAt.getTime()) / 60000)
      .sort((a, b) => a - b);

    const median = minutes.length
      ? minutes.length % 2
        ? minutes[(minutes.length - 1) / 2]!
        : (minutes[minutes.length / 2 - 1]! + minutes[minutes.length / 2]!) / 2
      : null;

    // Most Indian labs set a 60-minute policy for the callback.
    const within60 = minutes.filter((m) => m <= 60).length;

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      criticalResults: results.length,
      notified: notified.length,
      outstanding: results.length - notified.length,
      notificationRatePct: results.length
        ? Number(((notified.length / results.length) * 100).toFixed(1))
        : 100,
      medianMinutesToCall: median != null ? Number(median.toFixed(1)) : null,
      within60MinutesPct: notified.length
        ? Number(((within60 / notified.length) * 100).toFixed(1))
        : null,
    };
  }
}
