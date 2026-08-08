import { Injectable } from '@nestjs/common';
import type { Prisma } from '@labsetu/db';

/**
 * Gapless per-lab, per-day accession numbers.
 *
 * Gaplessness is not cosmetic. An assessor reading HYD26073100041 followed by
 * HYD26073100043 will ask what happened to 42, and "our numbering has gaps"
 * is not an answer that ends the conversation. So the counter is incremented
 * inside the same transaction as the sample insert: if the sample rolls back,
 * so does the number.
 *
 * The UPSERT with an atomic increment also means two concurrent registrations
 * cannot claim the same number — Postgres serialises them on the row lock.
 */
@Injectable()
export class AccessionService {
  async nextSampleAccession(
    tx: Prisma.TransactionClient,
    tenantId: string,
    labId: string,
    labCode: string,
    when: Date = new Date(),
  ): Promise<string> {
    const scope = `SAMPLE:${isoDate(when)}`;
    const counter = await this.increment(tx, tenantId, labId, scope);
    return `${labCode}${yymmdd(when)}${String(counter).padStart(5, '0')}`;
  }

  async nextOrderNumber(
    tx: Prisma.TransactionClient,
    tenantId: string,
    labId: string,
    when: Date = new Date(),
  ): Promise<string> {
    const scope = `ORDER:${isoDate(when)}`;
    const counter = await this.increment(tx, tenantId, labId, scope);
    return `ORD${yymmdd(when)}${String(counter).padStart(4, '0')}`;
  }

  /**
   * Invoice numbers are scoped per financial year, not per day — GST filings are
   * annual and a number must be unique within the year it is reported in.
   * India's financial year starts 1 April.
   */
  async nextInvoiceNumber(
    tx: Prisma.TransactionClient,
    tenantId: string,
    labId: string,
    when: Date = new Date(),
  ): Promise<string> {
    const fy = financialYear(when);
    const counter = await this.increment(tx, tenantId, labId, `INVOICE:${fy}`);
    return `INV/${fy}/${String(counter).padStart(5, '0')}`;
  }

  /**
   * Goods receipt notes.
   *
   * Its own scope, not a borrowed order number. Sharing ORDER's counter burned
   * an order number on every consignment and tied two sequences together that
   * an auditor reads separately — a gap in either then looks like a deletion in
   * the other.
   */
  async nextGrnNumber(
    tx: Prisma.TransactionClient,
    tenantId: string,
    labId: string,
    when: Date = new Date(),
  ): Promise<string> {
    const counter = await this.increment(tx, tenantId, labId, `GRN:${isoDate(when)}`);
    return `GRN${yymmdd(when)}${String(counter).padStart(4, '0')}`;
  }

  async nextReportNumber(
    tx: Prisma.TransactionClient,
    tenantId: string,
    labId: string,
    when: Date = new Date(),
  ): Promise<string> {
    const counter = await this.increment(tx, tenantId, labId, `REPORT:${isoDate(when)}`);
    return `RPT${yymmdd(when)}${String(counter).padStart(4, '0')}`;
  }

  private async increment(
    tx: Prisma.TransactionClient,
    tenantId: string,
    labId: string,
    scope: string,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ counter: number }[]>`
      INSERT INTO accession_counter ("id", "tenantId", "labId", scope, counter, "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${labId}::uuid, ${scope}, 1, now())
      ON CONFLICT ("tenantId", "labId", scope)
      DO UPDATE SET counter = accession_counter.counter + 1, "updatedAt" = now()
      RETURNING counter
    `;
    return rows[0]!.counter;
  }
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const yymmdd = (d: Date) =>
  `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate(),
  ).padStart(2, '0')}`;

function financialYear(d: Date): string {
  const year = d.getFullYear();
  // Jan-Mar belongs to the financial year that began the previous April.
  const startYear = d.getMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
