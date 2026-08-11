import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@labsetu/db';
import type { InstrumentMessageEnvelope, InstrumentObservation } from '@labsetu/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { CatalogService } from '../catalog/catalog.service';
import { RequestContextStore } from '../../common/context/request-context';
import { ageInDays } from '../patients/patients.service';

/**
 * Cloud side of the instrument pipeline (ADR 0004).
 *
 * Two rules govern everything here:
 *
 *   1. Instrument results are NEVER auto-authorised. They land at
 *      RESULT_ENTERED and still require human verification and authorisation.
 *   2. An observation that cannot be confidently matched goes to the exception
 *      queue — never dropped, never guessed. A mis-matched result is a
 *      patient-safety event; a queue item is an inconvenience.
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * Accepts an envelope, archives it, and maps it.
   *
   * Mapping runs inline today. It is deliberately a standalone entry point
   * (`processMessage`) so moving it behind BullMQ is a wiring change rather than
   * a refactor — the moment ingest volume makes a synchronous ack too slow, the
   * gateway's store-and-forward outbox already tolerates a 202-then-process
   * pattern.
   */
  async ingest(envelope: InstrumentMessageEnvelope, device: { id: string; tenantId: string; isShadowMode: boolean }) {
    const tx = this.prisma.tx;

    // Idempotent on messageId: a gateway replaying its outbox after a network
    // blip must not create duplicate results.
    const existing = await tx.instrumentMessage.findFirst({
      where: { messageId: envelope.messageId },
      select: { id: true, receivedAt: true },
    });
    if (existing) {
      return {
        messageId: envelope.messageId,
        status: 'DUPLICATE' as const,
        receivedAt: existing.receivedAt.toISOString(),
      };
    }

    const message = await tx.instrumentMessage.create({
      data: {
        tenantId: device.tenantId,
        deviceId: device.id,
        messageId: envelope.messageId,
        protocol: envelope.protocol,
        capturedAt: new Date(envelope.capturedAt),
        rawChecksum: envelope.rawChecksum,
        rawPreview: envelope.rawPreview ?? null,
        observationCount: envelope.observations.length,
        status: 'RECEIVED',
        // The full envelope is retained verbatim. If a parser turns out to be
        // wrong, the original is still here to reprocess — and an auditor can be
        // shown exactly what the instrument emitted (ALCOA+ "original").
        payload: envelope as unknown as Prisma.InputJsonValue,
      },
    });

    await this.audit.record(tx, {
      tenantId: device.tenantId,
      actorDeviceId: device.id,
      action: 'INGEST_RECEIVED',
      entityType: 'InstrumentMessage',
      entityId: message.id,
      after: {
        messageId: envelope.messageId,
        protocol: envelope.protocol,
        observationCount: envelope.observations.length,
        rawChecksum: envelope.rawChecksum,
        shadowMode: device.isShadowMode,
      },
    });

    await this.processMessage(message.id);

    await tx.device.update({
      where: { id: device.id },
      data: { lastMessageAt: new Date(), lastSeenAt: new Date() },
    });

    return {
      messageId: envelope.messageId,
      status: 'ACCEPTED' as const,
      receivedAt: message.receivedAt.toISOString(),
    };
  }

  /**
   * Maps observations onto sample tests and writes results.
   *
   * Entry point for both the inline path and a future queue worker.
   */
  async processMessage(messageRowId: string): Promise<void> {
    const tx = this.prisma.tx;

    const message = await tx.instrumentMessage.findUniqueOrThrow({
      where: { id: messageRowId },
      include: { device: { include: { channels: { include: { analyte: true } } } } },
    });

    const envelope = message.payload as unknown as InstrumentMessageEnvelope;
    const channels = new Map(message.device.channels.map((c) => [c.instrumentCode, c]));

    let written = 0;
    let held = 0;

    for (const obs of envelope.observations) {
      const outcome = await this.mapObservation(obs, message, channels);
      if (outcome.kind === 'WRITTEN') written++;
      else {
        held++;
        await tx.ingestException.create({
          data: {
            tenantId: message.tenantId,
            messageRowId,
            reason: outcome.reason,
            detail: outcome.detail,
            specimenRef: obs.specimenRef,
            instrumentCode: obs.testCode,
            rawObservation: obs as unknown as Prisma.InputJsonValue,
          },
        });
      }
    }

    await tx.instrumentMessage.update({
      where: { id: messageRowId },
      data: {
        status: held === 0 ? 'PROCESSED' : written === 0 ? 'FAILED' : 'PARTIAL',
        processedAt: new Date(),
        errorDetail: held > 0 ? `${held} observation(s) held for review` : null,
      },
    });

    if (held > 0) {
      this.logger.warn(
        `Message ${envelope.messageId}: ${written} written, ${held} held for review`,
      );
    }
  }

  private async mapObservation(
    obs: InstrumentObservation,
    message: { id: string; tenantId: string; deviceId: string; device: { isShadowMode: boolean } },
    channels: Map<string, { analyteId: string; testDefinitionId: string | null; unitConversionFactor: Prisma.Decimal | null; targetUnit: string | null }>,
  ): Promise<
    | { kind: 'WRITTEN' }
    | { kind: 'HELD'; reason: 'UNKNOWN_SPECIMEN' | 'UNMAPPED_CHANNEL' | 'TEST_NOT_ORDERED' | 'INVALID_VALUE' | 'TEST_ALREADY_AUTHORIZED' | 'DEVICE_IN_SHADOW_MODE'; detail: string }
  > {
    const tx = this.prisma.tx;

    // Shadow mode: parse and record everything, write nothing. This is the step
    // that makes analyzer onboarding safe to hand to an implementation engineer
    // — results are compared against manual entries before being trusted.
    if (message.device.isShadowMode) {
      return {
        kind: 'HELD',
        reason: 'DEVICE_IN_SHADOW_MODE',
        detail: 'Device is in shadow mode; parsed successfully but not written to patient records',
      };
    }

    const channel = channels.get(obs.testCode);
    if (!channel) {
      return {
        kind: 'HELD',
        reason: 'UNMAPPED_CHANNEL',
        detail: `Instrument code "${obs.testCode}" is not mapped to an analyte for this device`,
      };
    }

    const sample = await tx.sample.findFirst({
      where: {
        OR: [
          { accessionNumber: obs.specimenRef.trim().toUpperCase() },
          { barcode: obs.specimenRef.trim() },
        ],
      },
      include: {
        patient: {
          select: {
            id: true,
            sex: true,
            dateOfBirth: true,
            ageYears: true,
            ageMonths: true,
            ageDays: true,
          },
        },
      },
    });

    if (!sample) {
      return {
        kind: 'HELD',
        reason: 'UNKNOWN_SPECIMEN',
        detail: `No sample found for specimen reference "${obs.specimenRef}"`,
      };
    }

    const sampleTest = await tx.sampleTest.findFirst({
      where: {
        sampleId: sample.id,
        ...(channel.testDefinitionId
          ? { testDefinitionId: channel.testDefinitionId }
          : { testDefinition: { analytes: { some: { analyteId: channel.analyteId } } } }),
        status: { notIn: ['CANCELLED'] },
      },
      orderBy: { rerunCount: 'desc' },
    });

    if (!sampleTest) {
      return {
        kind: 'HELD',
        reason: 'TEST_NOT_ORDERED',
        detail: `Sample ${sample.accessionNumber} has no ordered test covering instrument code "${obs.testCode}"`,
      };
    }

    // Never silently overwrite an authorised result. A correction after
    // authorisation is an explicit, reasoned, signed amendment.
    if (['AUTHORIZED', 'REPORTED'].includes(sampleTest.status)) {
      return {
        kind: 'HELD',
        reason: 'TEST_ALREADY_AUTHORIZED',
        detail: `Test is already ${sampleTest.status}. Use an amendment to change an authorised result.`,
      };
    }

    let numeric: Prisma.Decimal | null = null;
    const bounded = /^([<>]=?)?\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.exec(obs.value.trim());
    if (bounded) {
      numeric = new Prisma.Decimal(bounded[2]!);
      if (channel.unitConversionFactor) numeric = numeric.mul(channel.unitConversionFactor);
    }

    // Our reference range, not the instrument's. Analyzers are frequently
    // configured with stale ranges, and importing one would put someone else's
    // data-entry error into a clinical report.
    const range = await this.catalog.resolveReferenceRange(
      tx,
      channel.analyteId,
      sample.patient?.sex ?? 'UNKNOWN',
      sample.patient ? ageInDays(sample.patient) : null,
    );

    const flag = this.flagFor(numeric, range);

    const previous = await tx.result.findFirst({
      where: { sampleTestId: sampleTest.id, analyteId: channel.analyteId, isCurrent: true },
    });
    if (previous) {
      await tx.result.update({ where: { id: previous.id }, data: { isCurrent: false } });
    }

    await tx.result.create({
      data: {
        tenantId: message.tenantId,
        sampleTestId: sampleTest.id,
        analyteId: channel.analyteId,
        version: (previous?.version ?? 0) + 1,
        isCurrent: true,
        value: obs.value.trim(),
        numericValue: numeric,
        unit: channel.targetUnit ?? obs.units ?? null,
        refRangeId: range?.id ?? null,
        refLow: range?.lowValue ?? null,
        refHigh: range?.highValue ?? null,
        refDisplay: range
          ? range.displayText ??
            (range.lowValue && range.highValue ? `${range.lowValue} - ${range.highValue}` : null)
          : null,
        flag: flag.flag,
        isCritical: flag.isCritical,
        source: 'INSTRUMENT',
        deviceId: message.deviceId,
        instrumentMessageId: message.id,
      },
    });

    // Status advances to RESULT_ENTERED only — human verification and
    // authorisation are still required.
    if (['PENDING', 'IN_PROGRESS'].includes(sampleTest.status)) {
      await tx.sampleTest.update({
        where: { id: sampleTest.id },
        data: {
          status: 'RESULT_ENTERED',
          resultAt: new Date(),
          deviceId: message.deviceId,
          startedAt: sampleTest.startedAt ?? new Date(),
        },
      });
    }

    return { kind: 'WRITTEN' };
  }

  private flagFor(
    numeric: Prisma.Decimal | null,
    range: {
      lowValue: Prisma.Decimal | null;
      highValue: Prisma.Decimal | null;
      criticalLow: Prisma.Decimal | null;
      criticalHigh: Prisma.Decimal | null;
    } | null,
  ): { flag: 'NORMAL' | 'LOW' | 'HIGH' | 'CRITICAL_LOW' | 'CRITICAL_HIGH'; isCritical: boolean } {
    if (!numeric || !range) return { flag: 'NORMAL', isCritical: false };
    if (range.criticalLow && numeric.lessThan(range.criticalLow)) {
      return { flag: 'CRITICAL_LOW', isCritical: true };
    }
    if (range.criticalHigh && numeric.greaterThan(range.criticalHigh)) {
      return { flag: 'CRITICAL_HIGH', isCritical: true };
    }
    if (range.lowValue && numeric.lessThan(range.lowValue)) return { flag: 'LOW', isCritical: false };
    if (range.highValue && numeric.greaterThan(range.highValue)) {
      return { flag: 'HIGH', isCritical: false };
    }
    return { flag: 'NORMAL', isCritical: false };
  }

  /**
   * Connected instruments and their health.
   *
   * The question a lab manager actually asks is "is the analyser talking to us
   * right now" — so the derived `isOnline` flag matters more than the stored
   * status. Fifteen minutes of silence is the practical threshold: analysers
   * heartbeat every few minutes, and anything longer means the gateway, the
   * serial cable or the instrument itself has stopped.
   */
  /**
   * Records a calibration against an instrument and moves its due date.
   *
   * The gate on authorisation is only defensible if there is a way through it
   * that is not "turn the check off". This is that way: the engineer records
   * what was done, against which certificate, and when it next falls due.
   *
   * Audited as its own verb. A calibration date moving is exactly the kind of
   * change an investigator wants attributed — "who extended this, and on what
   * evidence" is the question after a batch is queried.
   */
  async recordCalibration(
    deviceId: string,
    input: { performedAt: Date; nextDueAt: Date; certificateRef: string; note?: string },
  ) {
    const tx = this.prisma.tx;

    const device = await tx.device.findUnique({
      where: { id: deviceId },
      select: { id: true, code: true, name: true, calibrationDueAt: true },
    });
    if (!device) throw new NotFoundException('Instrument not found');

    if (input.nextDueAt <= input.performedAt) {
      throw new BadRequestException(
        'The next calibration is due before the calibration was performed. Check the dates.',
      );
    }

    const updated = await tx.device.update({
      where: { id: deviceId },
      data: { calibrationDueAt: input.nextDueAt },
    });

    await this.audit.record(tx, {
      action: 'CALIBRATION_RECORDED',
      entityType: 'Device',
      entityId: deviceId,
      before: { calibrationDueAt: device.calibrationDueAt?.toISOString() ?? null },
      after: {
        code: device.code,
        performedAt: input.performedAt.toISOString(),
        calibrationDueAt: updated.calibrationDueAt?.toISOString() ?? null,
        certificateRef: input.certificateRef,
      },
      reason: input.note ?? `Calibration recorded against ${input.certificateRef}`,
    });

    return {
      id: updated.id,
      code: device.code,
      calibrationDueAt: updated.calibrationDueAt?.toISOString().slice(0, 10) ?? null,
      isOutOfCalibration: false,
    };
  }

  async listDevices() {
    const devices = await this.prisma.tx.device.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: {
        lab: { select: { code: true, name: true } },
        _count: { select: { channels: true } },
      },
    });

    const staleAfterMs = 15 * 60_000;
    const now = Date.now();

    // Exceptions hang off the message, not the device, so the attribution runs
    // through the join rather than a groupBy.
    const openExceptions = await this.prisma.tx.ingestException.findMany({
      where: { status: 'OPEN' },
      select: { message: { select: { deviceId: true } } },
    });
    const exceptionsByDevice = new Map<string, number>();
    for (const e of openExceptions) {
      const id = e.message?.deviceId;
      if (id) exceptionsByDevice.set(id, (exceptionsByDevice.get(id) ?? 0) + 1);
    }

    return devices.map((d) => ({
      id: d.id,
      code: d.code,
      name: d.name,
      manufacturer: d.manufacturer,
      model: d.model,
      department: d.department,
      protocol: d.protocol,
      status: d.status,
      isActive: d.isActive,
      /// Shadow mode: results are captured and compared but never posted to the
      /// clinical record. This is how a new analyser is commissioned safely.
      isShadowMode: d.isShadowMode,
      lab: d.lab ? { code: d.lab.code, name: d.lab.name } : null,
      channelCount: d._count.channels,
      lastMessageAt: d.lastMessageAt?.toISOString() ?? null,
      minutesSinceLastMessage: d.lastMessageAt
        ? Math.round((now - d.lastMessageAt.getTime()) / 60000)
        : null,
      isOnline: !!d.lastMessageAt && now - d.lastMessageAt.getTime() < staleAfterMs,
      openExceptions: exceptionsByDevice.get(d.id) ?? 0,
      /// Calibration is a hard gate on authorisation, so the screen has to show
      /// it before someone runs a day's work on an instrument that cannot sign
      /// anything off. "Due in 9 days" is actionable; discovering it at the
      /// point of authorisation is not.
      calibrationDueAt: d.calibrationDueAt?.toISOString().slice(0, 10) ?? null,
      calibrationDueInDays: d.calibrationDueAt
        ? Math.ceil((d.calibrationDueAt.getTime() - now) / 864e5)
        : null,
      isOutOfCalibration: !!d.calibrationDueAt && d.calibrationDueAt.getTime() < now,
    }));
  }

  async listExceptions(status = 'OPEN', limit = 50) {
    return this.prisma.tx.ingestException.findMany({
      where: { status: status as never },
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        message: { select: { messageId: true, device: { select: { code: true, name: true } } } },
      },
    });
  }

  async resolveException(id: string, note: string) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const updated = await tx.ingestException.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        resolvedBy: ctx.userId,
        resolutionNote: note,
      },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'IngestException',
      entityId: id,
      reason: note,
      after: { status: 'RESOLVED' },
    });

    return updated;
  }
}
