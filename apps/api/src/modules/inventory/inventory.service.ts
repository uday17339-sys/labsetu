import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@labsetu/db';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { RequestContextStore } from '../../common/context/request-context';

export interface ReceiveStockInput {
  itemId: string;
  lotNumber: string;
  quantity: number;
  expiryDate?: Date;
  supplier?: string;
  invoiceRef?: string;
  unitCost?: number;
  openStabilityDays?: number;
}

export interface ConsumeInput {
  itemId: string;
  quantity: number;
  sampleTestId?: string;
  reason?: string;
  /** Consume from a specific lot instead of the FEFO pick. */
  lotId?: string;
}

/**
 * Reagent, control and consumable inventory.
 *
 * The compliance behaviour that makes this more than a stock ledger: consumption
 * from an EXPIRED lot is REFUSED. A result produced with an expired reagent is
 * not defensible to an assessor, so the system removes the possibility rather
 * than warning about it — the same pattern as the QC gate on authorisation.
 *
 * Allocation is FEFO (first-expiry-first-out), which is what a lab actually
 * does and what minimises write-off.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Items with aggregated stock, expiry and reorder state. */
  async listItems(category?: string) {
    const tx = this.prisma.tx;

    const items = await tx.inventoryItem.findMany({
      where: { isActive: true, ...(category ? { category: category as never } : {}) },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      include: {
        lots: {
          where: { status: { in: ['AVAILABLE', 'IN_USE'] } },
          orderBy: [{ expiryDate: 'asc' }],
        },
      },
    });

    const now = new Date();
    const soon = new Date(Date.now() + 30 * 864e5);

    return items.map((item) => {
      // Expired lots are excluded from usable stock. Counting them would tell a
      // lab manager they have reagent they cannot legitimately use.
      const usable = item.lots.filter((l) => !l.expiryDate || l.expiryDate > now);
      const onHand = usable.reduce((sum, l) => sum + l.quantityRemaining.toNumber(), 0);
      const expired = item.lots.filter((l) => l.expiryDate && l.expiryDate <= now);
      const expiringSoon = usable.filter((l) => l.expiryDate && l.expiryDate <= soon);
      const reorder = item.reorderLevel.toNumber();

      return {
        id: item.id,
        code: item.code,
        name: item.name,
        category: item.category,
        unit: item.unit,
        manufacturer: item.manufacturer,
        storageCondition: item.storageCondition,
        reorderLevel: reorder,
        quantityOnHand: Number(onHand.toFixed(3)),
        isBelowReorder: reorder > 0 && onHand < reorder,
        isOutOfStock: onHand <= 0,
        expiredLots: expired.length,
        expiringSoonLots: expiringSoon.length,
        // The soonest usable expiry — what a manager scans the column for.
        nextExpiry: usable.find((l) => l.expiryDate)?.expiryDate?.toISOString() ?? null,
        lots: item.lots.map((l) => ({
          id: l.id,
          lotNumber: l.lotNumber,
          quantityRemaining: l.quantityRemaining.toNumber(),
          expiryDate: l.expiryDate?.toISOString() ?? null,
          isExpired: !!l.expiryDate && l.expiryDate <= now,
          status: l.status,
          supplier: l.supplier,
        })),
      };
    });
  }

  /** Everything demanding attention right now. */
  async alerts() {
    const tx = this.prisma.tx;
    const now = new Date();
    const soon = new Date(Date.now() + 30 * 864e5);

    const [expired, expiring, items] = await Promise.all([
      tx.inventoryLot.findMany({
        where: { status: { in: ['AVAILABLE', 'IN_USE'] }, expiryDate: { lte: now } },
        include: { item: { select: { code: true, name: true, unit: true } } },
        orderBy: { expiryDate: 'asc' },
      }),
      tx.inventoryLot.findMany({
        where: {
          status: { in: ['AVAILABLE', 'IN_USE'] },
          expiryDate: { gt: now, lte: soon },
        },
        include: { item: { select: { code: true, name: true, unit: true } } },
        orderBy: { expiryDate: 'asc' },
      }),
      this.listItems(),
    ]);

    return {
      expired: expired.map((l) => ({
        lotId: l.id,
        item: l.item.name,
        code: l.item.code,
        lotNumber: l.lotNumber,
        expiryDate: l.expiryDate?.toISOString() ?? null,
        quantityRemaining: l.quantityRemaining.toNumber(),
        unit: l.item.unit,
      })),
      expiringSoon: expiring.map((l) => ({
        lotId: l.id,
        item: l.item.name,
        code: l.item.code,
        lotNumber: l.lotNumber,
        expiryDate: l.expiryDate?.toISOString() ?? null,
        daysLeft: l.expiryDate
          ? Math.ceil((l.expiryDate.getTime() - Date.now()) / 864e5)
          : null,
        quantityRemaining: l.quantityRemaining.toNumber(),
        unit: l.item.unit,
      })),
      belowReorder: items
        .filter((i) => i.isBelowReorder || i.isOutOfStock)
        .map((i) => ({
          itemId: i.id,
          code: i.code,
          name: i.name,
          quantityOnHand: i.quantityOnHand,
          reorderLevel: i.reorderLevel,
          unit: i.unit,
          isOutOfStock: i.isOutOfStock,
        })),
    };
  }

  /**
   * Registers a new stock item — a reagent, control, calibrator or consumable.
   *
   * `reorderLevel` is the only field with a non-obvious consequence: it is what
   * turns the stock screen from a ledger into an alert. An item with a reorder
   * level of zero will never warn anyone, which is fine for a rarely-used
   * consumable and quietly dangerous for a daily reagent.
   */
  async createItem(input: {
    code: string;
    name: string;
    category: string;
    unit: string;
    manufacturer?: string;
    catalogNumber?: string;
    reorderLevel?: number;
    storageCondition?: string;
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;
    const code = input.code.trim().toUpperCase();

    const clash = await tx.inventoryItem.findFirst({ where: { code } });
    if (clash) {
      throw new BadRequestException(
        `Stock code ${code} is already used by "${clash.name}"`,
      );
    }

    const item = await tx.inventoryItem.create({
      data: {
        tenantId: ctx.tenantId!,
        code,
        name: input.name.trim(),
        category: input.category as never,
        unit: input.unit.trim(),
        manufacturer: input.manufacturer?.trim() || null,
        catalogNumber: input.catalogNumber?.trim() || null,
        reorderLevel: new Prisma.Decimal(input.reorderLevel ?? 0),
        storageCondition: input.storageCondition?.trim() || null,
      },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'InventoryItem',
      entityId: item.id,
      after: {
        code: item.code,
        name: item.name,
        category: item.category,
        unit: item.unit,
        reorderLevel: item.reorderLevel.toNumber(),
        storageCondition: item.storageCondition,
      },
    });

    return { id: item.id, code: item.code, name: item.name, category: item.category };
  }

  /**
   * Links a reagent to a test, so running the test decrements stock
   * automatically. Without this the ledger only moves when someone remembers to
   * record consumption, which in practice means it stops matching the shelf.
   */
  async setTestUsage(input: {
    testDefinitionId: string;
    inventoryItemId: string;
    quantityPerTest: number;
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const [test, item] = await Promise.all([
      tx.testDefinition.findUnique({ where: { id: input.testDefinitionId } }),
      tx.inventoryItem.findUnique({ where: { id: input.inventoryItemId } }),
    ]);
    if (!test) throw new NotFoundException('Test not found');
    if (!item) throw new NotFoundException('Stock item not found');

    const usage = await tx.testReagentUsage.upsert({
      where: {
        testDefinitionId_inventoryItemId: {
          testDefinitionId: input.testDefinitionId,
          inventoryItemId: input.inventoryItemId,
        },
      },
      create: {
        tenantId: ctx.tenantId!,
        testDefinitionId: input.testDefinitionId,
        inventoryItemId: input.inventoryItemId,
        quantityPerTest: new Prisma.Decimal(input.quantityPerTest),
      },
      update: { quantityPerTest: new Prisma.Decimal(input.quantityPerTest) },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'TestReagentUsage',
      entityId: usage.id,
      after: {
        test: test.code,
        item: item.code,
        quantityPerTest: input.quantityPerTest,
        unit: item.unit,
      },
    });

    return {
      id: usage.id,
      test: test.code,
      item: item.code,
      quantityPerTest: input.quantityPerTest,
      unit: item.unit,
    };
  }

  async receive(input: ReceiveStockInput) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    if (input.quantity <= 0) {
      throw new BadRequestException('Received quantity must be greater than zero');
    }

    const item = await tx.inventoryItem.findUnique({ where: { id: input.itemId } });
    if (!item) throw new NotFoundException('Inventory item not found');

    if (input.expiryDate && input.expiryDate <= new Date()) {
      throw new BadRequestException(
        'This lot is already expired. Receiving it into usable stock would let it be consumed.',
      );
    }

    const existing = await tx.inventoryLot.findFirst({
      where: { itemId: input.itemId, lotNumber: input.lotNumber },
    });

    const qty = new Prisma.Decimal(input.quantity);
    let lot;

    if (existing) {
      // A second delivery of the same lot tops it up rather than creating a
      // duplicate — lot number plus item is the natural key a lab thinks in.
      lot = await tx.inventoryLot.update({
        where: { id: existing.id },
        data: {
          quantityReceived: existing.quantityReceived.add(qty),
          quantityRemaining: existing.quantityRemaining.add(qty),
          status: 'AVAILABLE',
        },
      });
    } else {
      lot = await tx.inventoryLot.create({
        data: {
          tenantId: ctx.tenantId!,
          itemId: input.itemId,
          lotNumber: input.lotNumber,
          expiryDate: input.expiryDate ?? null,
          quantityReceived: qty,
          quantityRemaining: qty,
          supplier: input.supplier ?? null,
          invoiceRef: input.invoiceRef ?? null,
          unitCost: input.unitCost !== undefined ? new Prisma.Decimal(input.unitCost) : null,
          openStabilityDays: input.openStabilityDays ?? null,
          receivedBy: ctx.userId,
          status: 'AVAILABLE',
        },
      });
    }

    await tx.stockTransaction.create({
      data: {
        tenantId: ctx.tenantId!,
        lotId: lot.id,
        type: 'RECEIPT',
        quantity: qty,
        balanceAfter: lot.quantityRemaining,
        reason: input.invoiceRef ? `Invoice ${input.invoiceRef}` : null,
        performedBy: ctx.userId,
      },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'InventoryLot',
      entityId: lot.id,
      after: {
        item: item.code,
        lotNumber: input.lotNumber,
        quantity: input.quantity,
        unit: item.unit,
        expiryDate: input.expiryDate?.toISOString().slice(0, 10) ?? null,
        supplier: input.supplier ?? null,
        balanceAfter: lot.quantityRemaining.toNumber(),
      },
    });

    return {
      lotId: lot.id,
      lotNumber: lot.lotNumber,
      quantityRemaining: lot.quantityRemaining.toNumber(),
      expiryDate: lot.expiryDate?.toISOString() ?? null,
    };
  }

  /**
   * Consumes stock, FEFO.
   *
   * Refuses an expired lot outright. Refuses to go negative — a stock figure
   * that can drift below zero is not a record anyone can rely on; the correct
   * response is an ADJUSTMENT with a documented reason.
   */
  async consume(input: ConsumeInput) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;
    const now = new Date();

    if (input.quantity <= 0) {
      throw new BadRequestException('Consumed quantity must be greater than zero');
    }

    const item = await tx.inventoryItem.findUnique({ where: { id: input.itemId } });
    if (!item) throw new NotFoundException('Inventory item not found');

    if (input.lotId) {
      const chosen = await tx.inventoryLot.findUnique({ where: { id: input.lotId } });
      if (!chosen) throw new NotFoundException('Lot not found');
      if (chosen.expiryDate && chosen.expiryDate <= now) {
        throw new BadRequestException(
          `Lot ${chosen.lotNumber} of ${item.name} expired on ` +
            `${chosen.expiryDate.toISOString().slice(0, 10)}. Results produced with an expired ` +
            `reagent are not defensible, so it cannot be consumed. Dispose of it and receive a new lot.`,
        );
      }
    }

    // FEFO: soonest expiry first, undated lots last.
    const candidates = await tx.inventoryLot.findMany({
      where: {
        itemId: input.itemId,
        status: { in: ['AVAILABLE', 'IN_USE'] },
        quantityRemaining: { gt: 0 },
        ...(input.lotId ? { id: input.lotId } : {}),
        OR: [{ expiryDate: null }, { expiryDate: { gt: now } }],
      },
      orderBy: [{ expiryDate: 'asc' }, { receivedAt: 'asc' }],
    });

    const available = candidates.reduce((s, l) => s + l.quantityRemaining.toNumber(), 0);

    if (available < input.quantity) {
      const expiredQty = await tx.inventoryLot.aggregate({
        where: {
          itemId: input.itemId,
          status: { in: ['AVAILABLE', 'IN_USE'] },
          expiryDate: { lte: now },
        },
        _sum: { quantityRemaining: true },
      });
      const blocked = expiredQty._sum.quantityRemaining?.toNumber() ?? 0;

      throw new BadRequestException(
        `Insufficient usable stock of ${item.name}: need ${input.quantity} ${item.unit}, ` +
          `have ${available.toFixed(3)}.` +
          (blocked > 0
            ? ` A further ${blocked.toFixed(3)} ${item.unit} is present but EXPIRED and cannot be used.`
            : ''),
      );
    }

    // Draw across lots in FEFO order.
    let outstanding = input.quantity;
    const drawn: { lotId: string; lotNumber: string; quantity: number }[] = [];

    for (const lot of candidates) {
      if (outstanding <= 0) break;
      const take = Math.min(outstanding, lot.quantityRemaining.toNumber());
      const takeDec = new Prisma.Decimal(take.toFixed(3));
      const balance = lot.quantityRemaining.sub(takeDec);

      await tx.inventoryLot.update({
        where: { id: lot.id },
        data: {
          quantityRemaining: balance,
          status: balance.lessThanOrEqualTo(0) ? 'EXHAUSTED' : 'IN_USE',
          openedAt: lot.openedAt ?? now,
        },
      });

      await tx.stockTransaction.create({
        data: {
          tenantId: ctx.tenantId!,
          lotId: lot.id,
          type: 'CONSUMPTION',
          quantity: takeDec.negated(),
          balanceAfter: balance,
          reason: input.reason ?? null,
          // The traceability an assessor asks for: which reagent lot produced
          // this result?
          sampleTestId: input.sampleTestId ?? null,
          performedBy: ctx.userId,
        },
      });

      drawn.push({ lotId: lot.id, lotNumber: lot.lotNumber, quantity: take });
      outstanding -= take;
    }

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'InventoryItem',
      entityId: input.itemId,
      reason: input.reason ?? null,
      after: {
        action: 'CONSUMPTION',
        item: item.code,
        quantity: input.quantity,
        unit: item.unit,
        lots: drawn.map((d) => `${d.lotNumber}:${d.quantity}`),
        sampleTestId: input.sampleTestId ?? null,
      },
    });

    return { consumed: input.quantity, unit: item.unit, lots: drawn };
  }

  /**
   * Automatic consumption when a test is run.
   *
   * Best-effort by design: a stock shortfall must NOT block a clinical result
   * that has already been produced. The shortfall surfaces on the inventory
   * screen instead. Blocking result entry on a stock figure would be the tail
   * wagging the dog.
   */
  async consumeForTest(sampleTestId: string, testDefinitionId: string): Promise<void> {
    const tx = this.prisma.tx;

    const usages = await tx.testReagentUsage.findMany({
      where: { testDefinitionId },
      include: { inventoryItem: { select: { id: true, code: true, name: true } } },
    });
    if (usages.length === 0) return;

    for (const usage of usages) {
      try {
        await this.consume({
          itemId: usage.inventoryItemId,
          quantity: usage.quantityPerTest.toNumber(),
          sampleTestId,
          reason: 'Automatic consumption on result entry',
        });
      } catch {
        // Swallowed deliberately — see the method comment. The alerts endpoint
        // and the inventory screen surface the resulting shortfall.
      }
    }
  }

  /** Stock count correction. Always requires a reason. */
  async adjust(lotId: string, newQuantity: number, reason: string) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const lot = await tx.inventoryLot.findUnique({
      where: { id: lotId },
      include: { item: { select: { code: true, name: true, unit: true } } },
    });
    if (!lot) throw new NotFoundException('Lot not found');
    if (newQuantity < 0) throw new BadRequestException('Quantity cannot be negative');

    const target = new Prisma.Decimal(newQuantity.toFixed(3));
    const delta = target.sub(lot.quantityRemaining);

    await tx.inventoryLot.update({
      where: { id: lotId },
      data: {
        quantityRemaining: target,
        status: target.lessThanOrEqualTo(0) ? 'EXHAUSTED' : lot.status === 'EXHAUSTED' ? 'AVAILABLE' : lot.status,
      },
    });

    await tx.stockTransaction.create({
      data: {
        tenantId: ctx.tenantId!,
        lotId,
        type: 'ADJUSTMENT',
        quantity: delta,
        balanceAfter: target,
        reason,
        performedBy: ctx.userId,
      },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'InventoryLot',
      entityId: lotId,
      reason,
      before: { quantityRemaining: lot.quantityRemaining.toNumber() },
      after: {
        action: 'ADJUSTMENT',
        item: lot.item.code,
        lotNumber: lot.lotNumber,
        quantityRemaining: newQuantity,
        delta: delta.toNumber(),
      },
    });

    return { lotId, quantityRemaining: newQuantity, delta: delta.toNumber() };
  }

  /** Writes off a lot — expired, damaged or contaminated. */
  async dispose(lotId: string, reason: string) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const lot = await tx.inventoryLot.findUnique({
      where: { id: lotId },
      include: { item: { select: { code: true, name: true, unit: true } } },
    });
    if (!lot) throw new NotFoundException('Lot not found');
    if (lot.status === 'DISPOSED') {
      throw new BadRequestException('This lot has already been disposed of');
    }

    const remaining = lot.quantityRemaining;

    await tx.inventoryLot.update({
      where: { id: lotId },
      data: {
        quantityRemaining: new Prisma.Decimal(0),
        status: 'DISPOSED',
        disposedAt: new Date(),
        disposalReason: reason,
      },
    });

    await tx.stockTransaction.create({
      data: {
        tenantId: ctx.tenantId!,
        lotId,
        type: 'DISPOSAL',
        quantity: remaining.negated(),
        balanceAfter: new Prisma.Decimal(0),
        reason,
        performedBy: ctx.userId,
      },
    });

    await this.audit.record(tx, {
      action: 'DELETE',
      entityType: 'InventoryLot',
      entityId: lotId,
      reason,
      before: { quantityRemaining: remaining.toNumber(), status: lot.status },
      after: {
        action: 'DISPOSAL',
        item: lot.item.code,
        lotNumber: lot.lotNumber,
        quantityWrittenOff: remaining.toNumber(),
        unit: lot.item.unit,
      },
    });

    return { lotId, quantityWrittenOff: remaining.toNumber(), reason };
  }

  /** Movement ledger for one lot — the stock-audit view. */
  async lotHistory(lotId: string) {
    const rows = await this.prisma.tx.stockTransaction.findMany({
      where: { lotId },
      orderBy: { performedAt: 'desc' },
      take: 200,
    });

    return rows.map((t) => ({
      id: t.id,
      type: t.type,
      quantity: t.quantity.toNumber(),
      balanceAfter: t.balanceAfter.toNumber(),
      reason: t.reason,
      sampleTestId: t.sampleTestId,
      performedAt: t.performedAt.toISOString(),
    }));
  }
}
