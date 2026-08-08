import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@labsetu/db';
import type { CreateOrderInput } from '@labsetu/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { AccessionService } from './accession.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * Registration: patient + requisition -> order -> sample(s) -> sample tests.
 *
 * One call does the whole front-desk flow because that is how the desk works —
 * splitting it across endpoints would leave half-registered orders behind
 * whenever a receptionist is interrupted mid-flow.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly accession: AccessionService,
  ) {}

  async create(input: CreateOrderInput) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const lab = await tx.lab.findUnique({ where: { id: input.labId } });
    if (!lab) throw new NotFoundException('Lab not found');

    const patient = await tx.patient.findUnique({ where: { id: input.patientId } });
    if (!patient) throw new NotFoundException('Patient not found');
    if (patient.erasedAt) {
      throw new BadRequestException('Cannot order tests for an erased patient record');
    }

    // Expand panels into their constituent tests up front, so each test can be
    // tracked, re-run or rejected independently — which is how labs work.
    const resolved = await this.resolveItems(tx, input.items);

    const orderNumber = await this.accession.nextOrderNumber(tx, ctx.tenantId!, lab.id);

    const order = await tx.labOrder.create({
      data: {
        tenantId: ctx.tenantId!,
        labId: lab.id,
        orderNumber,
        patientId: patient.id,
        referringDoctorId: input.referringDoctorId ?? null,
        referringOrgId: input.referringOrgId ?? null,
        priority: input.priority,
        clinicalNotes: input.clinicalNotes ?? null,
        provisionalDiagnosis: input.provisionalDiagnosis ?? null,
        createdBy: ctx.userId,
      },
    });

    let subTotal = new Prisma.Decimal(0);
    const createdItems: { id: string; tests: { id: string; specimenTypeId: string | null }[] }[] = [];

    for (const line of resolved) {
      const gross = line.unitPrice.mul(line.quantity);
      const net = gross.mul(new Prisma.Decimal(100 - line.discountPct)).div(100);

      const item = await tx.orderItem.create({
        data: {
          tenantId: ctx.tenantId!,
          orderId: order.id,
          testDefinitionId: line.testDefinitionId,
          panelId: line.panelId,
          quantity: line.quantity,
          // Price snapshot: the catalog may change tomorrow, the invoice must not.
          unitPrice: line.unitPrice,
          discountPct: new Prisma.Decimal(line.discountPct),
          netAmount: net,
        },
      });
      subTotal = subTotal.add(net);
      createdItems.push({ id: item.id, tests: line.tests });
    }

    // Group tests by specimen type: one sample (one tube, one accession number)
    // serves every test that shares its specimen requirement. Drawing a separate
    // tube per test would be both wasteful and clinically unnecessary.
    const samples: { id: string; accessionNumber: string; testCount: number }[] = [];

    if (input.createSample) {
      const bySpecimen = new Map<string, { orderItemId: string; testId: string }[]>();
      for (const item of createdItems) {
        for (const t of item.tests) {
          const key = t.specimenTypeId ?? 'UNSPECIFIED';
          const list = bySpecimen.get(key) ?? [];
          list.push({ orderItemId: item.id, testId: t.id });
          bySpecimen.set(key, list);
        }
      }

      for (const [specimenKey, entries] of bySpecimen) {
        const first = await tx.testDefinition.findUniqueOrThrow({
          where: { id: entries[0]!.testId },
          select: { containerTypeId: true },
        });

        const accessionNumber = await this.accession.nextSampleAccession(
          tx,
          ctx.tenantId!,
          lab.id,
          lab.code,
        );

        const sample = await tx.sample.create({
          data: {
            tenantId: ctx.tenantId!,
            labId: lab.id,
            orderId: order.id,
            accessionNumber,
            barcode: accessionNumber,
            patientId: patient.id,
            specimenTypeId: specimenKey === 'UNSPECIFIED' ? null : specimenKey,
            containerTypeId: first.containerTypeId,
            status: 'REGISTERED',
            priority: input.priority,
            createdBy: ctx.userId,
          },
        });

        for (const e of entries) {
          const td = await tx.testDefinition.findUniqueOrThrow({ where: { id: e.testId } });
          await tx.sampleTest.create({
            data: {
              tenantId: ctx.tenantId!,
              sampleId: sample.id,
              orderItemId: e.orderItemId,
              testDefinitionId: td.id,
              // Pin the catalog version so a later catalog change cannot
              // retroactively alter what this test meant.
              testVersion: td.version,
              status: 'PENDING',
              priority: input.priority,
              dueAt: td.tatMinutes ? new Date(Date.now() + td.tatMinutes * 60_000) : null,
            },
          });
        }

        samples.push({
          id: sample.id,
          accessionNumber,
          testCount: entries.length,
        });
      }
    }

    const invoiceNumber = await this.accession.nextInvoiceNumber(tx, ctx.tenantId!, lab.id);
    await tx.invoice.create({
      data: {
        tenantId: ctx.tenantId!,
        labId: lab.id,
        orderId: order.id,
        invoiceNumber,
        customerType: 'B2C',
        customerName: patient.patientCode,
        placeOfSupply: lab.state === 'Telangana' ? '36' : null,
        subTotal,
        taxableAmount: subTotal,
        // Diagnostic services are largely GST-exempt; the tax machinery exists
        // for the non-clinical lines that are not.
        totalAmount: subTotal,
        status: 'UNPAID',
        createdBy: ctx.userId,
      },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'LabOrder',
      entityId: order.id,
      after: {
        orderNumber,
        patientCode: patient.patientCode,
        priority: input.priority,
        itemCount: createdItems.length,
        samples: samples.map((s) => s.accessionNumber),
        subTotal: subTotal.toString(),
      },
    });

    return {
      id: order.id,
      orderNumber,
      invoiceNumber,
      subTotal: subTotal.toString(),
      samples,
    };
  }

  async findOne(id: string) {
    const order = await this.prisma.tx.labOrder.findUnique({
      where: { id },
      include: {
        patient: { select: { id: true, patientCode: true, sex: true, ageYears: true } },
        referringDoctor: { select: { name: true, qualification: true } },
        lab: { select: { code: true, name: true } },
        items: {
          include: {
            testDefinition: { select: { code: true, name: true } },
            panel: { select: { code: true, name: true } },
          },
        },
        samples: {
          include: {
            tests: {
              include: { testDefinition: { select: { code: true, name: true, department: true } } },
            },
          },
        },
        // Without this the UI cannot see that a report already exists for the
        // order, so the only affordance is "Generate" — which is how duplicates
        // get made in the first place.
        reports: {
          orderBy: [{ reportNumber: 'asc' }, { version: 'desc' }],
          select: {
            id: true,
            reportNumber: true,
            version: true,
            status: true,
            isPartial: true,
            releasedAt: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async list(params: { labId?: string; status?: string; limit: number; cursor?: string }) {
    const rows = await this.prisma.tx.labOrder.findMany({
      where: {
        ...(params.labId ? { labId: params.labId } : {}),
        ...(params.status ? { status: params.status as never } : {}),
      },
      take: params.limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      orderBy: { orderedAt: 'desc' },
      include: {
        patient: { select: { patientCode: true, sex: true, ageYears: true } },
        lab: { select: { code: true } },
        samples: { select: { accessionNumber: true, status: true } },
        _count: { select: { items: true } },
      },
    });

    const hasMore = rows.length > params.limit;
    const items = hasMore ? rows.slice(0, params.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }

  /** Expands panels and validates that every referenced test actually exists. */
  private async resolveItems(
    tx: Prisma.TransactionClient,
    items: CreateOrderInput['items'],
  ) {
    const resolved: {
      testDefinitionId: string | null;
      panelId: string | null;
      quantity: number;
      discountPct: number;
      unitPrice: Prisma.Decimal;
      tests: { id: string; specimenTypeId: string | null }[];
    }[] = [];

    for (const line of items) {
      if (line.panelId) {
        const panel = await tx.panel.findUnique({
          where: { id: line.panelId },
          include: { items: { include: { testDefinition: true } } },
        });
        if (!panel) throw new NotFoundException(`Panel ${line.panelId} not found`);
        if (panel.items.length === 0) {
          throw new BadRequestException(`Panel ${panel.code} contains no tests`);
        }
        resolved.push({
          testDefinitionId: null,
          panelId: panel.id,
          quantity: line.quantity,
          discountPct: line.discountPct,
          unitPrice: panel.price,
          tests: panel.items.map((i) => ({
            id: i.testDefinition.id,
            specimenTypeId: i.testDefinition.specimenTypeId,
          })),
        });
      } else {
        const td = await tx.testDefinition.findUnique({ where: { id: line.testDefinitionId! } });
        if (!td) throw new NotFoundException(`Test ${line.testDefinitionId} not found`);
        if (!td.isActive) throw new BadRequestException(`Test ${td.code} is no longer offered`);
        resolved.push({
          testDefinitionId: td.id,
          panelId: null,
          quantity: line.quantity,
          discountPct: line.discountPct,
          unitPrice: td.price,
          tests: [{ id: td.id, specimenTypeId: td.specimenTypeId }],
        });
      }
    }

    return resolved;
  }
}
