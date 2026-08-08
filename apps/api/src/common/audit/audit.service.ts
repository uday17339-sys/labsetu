import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@labsetu/db';
import { auditEntryHash, AUDIT_GENESIS_HASH } from '@labsetu/crypto';
import type { AuditAction } from '@labsetu/contracts';
import { RequestContextStore } from '../context/request-context';

export interface AuditInput {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  /** Mandatory for changes to released or authorised data. */
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  /** Overrides for background jobs, which have no HTTP request context. */
  tenantId?: string;
  actorUserId?: string | null;
  actorDisplay?: string | null;
  actorRole?: string | null;
  actorDeviceId?: string | null;
}

/**
 * Writes the hash-chained, append-only audit trail (ADR 0003).
 *
 * This is the subsystem the product is actually selling. Three properties are
 * non-negotiable and are all enforced here or in the database:
 *
 *   1. It writes in the SAME transaction as the data change. There is no window
 *      in which a change exists without its audit entry, and no way for the
 *      audit write to fail independently.
 *   2. `occurredAt` is never supplied by us — the column default and a database
 *      trigger assign server time. That is what makes backdating impossible
 *      rather than merely discouraged.
 *   3. Each entry hashes the previous one, so removing or altering history
 *      breaks every subsequent link.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  /**
   * Set by CommonModule after construction. AuditService cannot take
   * PrismaService as a constructor dependency without creating a cycle
   * (PrismaService -> RequestContext -> AuditService), so the one method that
   * needs its own transaction receives it via a setter.
   */
  private txRunner?: <T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) => Promise<T>;

  setTransactionRunner(
    runner: <T>(
      tenantId: string,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ) => Promise<T>,
  ): void {
    this.txRunner = runner;
  }

  /**
   * Records an event in its OWN transaction, committed independently of the
   * caller's.
   *
   * This exists for security events attached to FAILING requests — a rejected
   * login, a detected token reuse, a permission denial. Those are written while
   * the surrounding transaction is about to roll back, and a rolled-back audit
   * entry means a brute-force attempt leaves no trace at all. The audit trail
   * must record what was attempted, not only what succeeded.
   *
   * MUST NOT be called from inside a transaction that already holds this
   * tenant's audit chain-head lock — it would deadlock against itself.
   */
  async recordIndependent(tenantId: string, input: AuditInput): Promise<void> {
    if (!this.txRunner) {
      this.logger.error('Audit transaction runner not wired; security event NOT recorded');
      return;
    }
    try {
      await this.txRunner(tenantId, (tx) => this.record(tx, { ...input, tenantId }));
    } catch (err) {
      // Never let an audit failure mask the security response being returned,
      // but make it loud — a silently missing audit trail is its own incident.
      this.logger.error(
        `Failed to record security audit event ${input.action}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Appends one entry. Must be called with the transaction that carries the
   * data change it describes.
   *
   * The chain head row is locked FOR UPDATE, which serialises appends per
   * tenant. Two concurrent requests for the same tenant queue here rather than
   * racing to claim the same sequence number — correctness bought at the cost
   * of a little concurrency, which is the right trade for this table.
   */
  async record(tx: Prisma.TransactionClient, input: AuditInput): Promise<string> {
    const ctx = RequestContextStore.get();

    const tenantId = input.tenantId ?? ctx?.tenantId;
    if (!tenantId) {
      throw new Error('AuditService.record requires a tenantId (context or explicit)');
    }

    // Lock the chain head. Postgres holds this until the transaction commits,
    // so the sequence and hash cannot interleave with another append.
    const headRows = await tx.$queryRaw<{ seq: bigint; headHash: string }[]>`
      SELECT seq, "headHash" FROM audit_chain_head
      WHERE "tenantId" = ${tenantId}::uuid
      FOR UPDATE
    `;

    let prevSeq = 0n;
    let prevHash = AUDIT_GENESIS_HASH;

    if (headRows.length === 0) {
      // First entry for this tenant. Genesis hash is a documented constant so
      // an independent verifier can reproduce the first link.
      await tx.$executeRaw`
        INSERT INTO audit_chain_head ("tenantId", seq, "headHash", "updatedAt")
        VALUES (${tenantId}::uuid, 0, ${AUDIT_GENESIS_HASH}, now())
      `;
    } else {
      prevSeq = headRows[0]!.seq;
      prevHash = headRows[0]!.headHash;
    }

    const seq = prevSeq + 1n;

    const before = normalise(input.before);
    const after = normalise(input.after);
    const changedFields = diffFields(before, after);

    // The hashed payload deliberately excludes occurredAt: the database assigns
    // it, so we cannot know it before the INSERT. Ordering is instead pinned by
    // `seq`, which is part of the hash and uniquely constrained — a stronger
    // guarantee than a timestamp, which can tie.
    const entry = {
      tenantId,
      seq: seq.toString(),
      actorUserId: input.actorUserId ?? ctx?.userId ?? null,
      actorRole: input.actorRole ?? ctx?.userRole ?? null,
      actorDeviceId: input.actorDeviceId ?? ctx?.deviceId ?? null,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      action: input.action,
      reason: input.reason ?? null,
      before,
      after,
      changedFields,
    };

    const hash = auditEntryHash(prevHash, entry);

    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO audit_log (
        id, "tenantId", seq, "actorUserId", "actorDisplay", "actorRole",
        "actorIp", "actorUserAgent", "requestId", "actorDeviceId",
        "entityType", "entityId", action, reason,
        before, after, "changedFields", "prevHash", hash
      ) VALUES (
        gen_random_uuid(), ${tenantId}::uuid, ${seq},
        ${entry.actorUserId}::uuid,
        ${input.actorDisplay ?? ctx?.userDisplay ?? null},
        ${entry.actorRole},
        ${ctx?.ip ?? null}, ${ctx?.userAgent ?? null}, ${ctx?.requestId ?? null},
        ${entry.actorDeviceId}::uuid,
        ${entry.entityType}, ${entry.entityId}, ${entry.action}, ${entry.reason},
        ${before === null ? null : JSON.stringify(before)}::jsonb,
        ${after === null ? null : JSON.stringify(after)}::jsonb,
        ${changedFields}::text[],
        ${prevHash}, ${hash}
      )
      RETURNING id
    `;

    await tx.$executeRaw`
      UPDATE audit_chain_head
      SET seq = ${seq}, "headHash" = ${hash}, "updatedAt" = now()
      WHERE "tenantId" = ${tenantId}::uuid
    `;

    return inserted[0]!.id;
  }

  /**
   * Walks a tenant's chain and recomputes every hash.
   *
   * The evidence this produces is what a lab shows an assessor — arguably worth
   * more at an inspection than the chain itself, because it demonstrates
   * continuous monitoring rather than a one-off claim.
   */
  async verifyChain(
    client: Prisma.TransactionClient,
    tenantId: string,
    opts: { fromSeq?: bigint; batchSize?: number } = {},
  ): Promise<{ ok: boolean; checked: number; failedAtSeq?: bigint; detail?: string }> {
    const batchSize = opts.batchSize ?? 1000;
    let cursor = opts.fromSeq ?? 0n;
    let prevHash = cursor === 0n ? AUDIT_GENESIS_HASH : await this.hashAt(client, tenantId, cursor);
    let checked = 0;

    for (;;) {
      const rows = await client.$queryRaw<AuditRow[]>`
        SELECT seq, "actorUserId", "actorRole", "actorDeviceId", "entityType",
               "entityId", action, reason, before, after, "changedFields",
               "prevHash", hash
        FROM audit_log
        WHERE "tenantId" = ${tenantId}::uuid AND seq > ${cursor}
        ORDER BY seq ASC
        LIMIT ${batchSize}
      `;

      if (rows.length === 0) break;

      for (const row of rows) {
        // A gap means an entry was removed: seq is uniquely constrained, so it
        // cannot be a natural skip.
        if (row.seq !== cursor + 1n) {
          return {
            ok: false,
            checked,
            failedAtSeq: row.seq,
            detail: `Sequence gap: expected ${cursor + 1n}, found ${row.seq}`,
          };
        }

        if (row.prevHash !== prevHash) {
          return {
            ok: false,
            checked,
            failedAtSeq: row.seq,
            detail: `Broken link at seq ${row.seq}: stored prevHash does not match the previous entry's hash`,
          };
        }

        const recomputed = auditEntryHash(prevHash, {
          tenantId,
          seq: row.seq.toString(),
          actorUserId: row.actorUserId,
          actorRole: row.actorRole,
          actorDeviceId: row.actorDeviceId,
          entityType: row.entityType,
          entityId: row.entityId,
          action: row.action,
          reason: row.reason,
          before: row.before,
          after: row.after,
          changedFields: row.changedFields,
        });

        if (recomputed !== row.hash) {
          return {
            ok: false,
            checked,
            failedAtSeq: row.seq,
            detail: `Content altered at seq ${row.seq}: recomputed hash does not match the stored hash`,
          };
        }

        prevHash = row.hash;
        cursor = row.seq;
        checked++;
      }
    }

    return { ok: true, checked };
  }

  private async hashAt(
    client: Prisma.TransactionClient,
    tenantId: string,
    seq: bigint,
  ): Promise<string> {
    const rows = await client.$queryRaw<{ hash: string }[]>`
      SELECT hash FROM audit_log WHERE "tenantId" = ${tenantId}::uuid AND seq = ${seq}
    `;
    if (rows.length === 0) {
      throw new Error(`Cannot resume verification from seq ${seq}: entry not found`);
    }
    return rows[0]!.hash;
  }
}

interface AuditRow {
  seq: bigint;
  actorUserId: string | null;
  actorRole: string | null;
  actorDeviceId: string | null;
  entityType: string;
  entityId: string | null;
  action: string;
  reason: string | null;
  before: unknown;
  after: unknown;
  changedFields: string[];
  prevHash: string;
  hash: string;
}

/**
 * Strips values that must never enter the audit trail.
 *
 * The audit log is broadly readable (auditors, admins, compliance exports), so
 * a leaked secret here is worse than in an application log — it is retained for
 * years and cannot be deleted.
 */
const REDACTED_KEYS = new Set([
  'password',
  'passwordHash',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'token',
  'accessToken',
  'refreshToken',
  'signingToken',
  'mfaToken',
  'tokenHash',
  'mfaSecretEnc',
  'mfaRecoveryCodes',
  'dataKeyEnc',
  'deviceSecretEnc',
  'deviceKeyHash',
  'totpCode',
  'secret',
]);

function normalise(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') return { value };
  return redact(value as Record<string, unknown>) as Record<string, unknown>;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (value instanceof Date) return value.toISOString();

  // Prisma Decimal and similar wrappers.
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return (value as { toJSON: () => unknown }).toJSON();
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_KEYS.has(k)) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'bigint') {
      out[k] = v.toString();
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

function diffFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed.push(k);
  }
  return changed.sort();
}
