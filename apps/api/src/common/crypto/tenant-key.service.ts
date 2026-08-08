import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from './crypto.service';

/**
 * Resolves and caches a tenant's data-encryption key.
 *
 * Split out from CryptoService because it needs database access, and because
 * key resolution is the one place where a cache bug has an outsized blast
 * radius: a stale key after rotation means unreadable patient data, and a key
 * that outlives a tenant suspension is a control failure. Keeping it in one
 * small, reviewable class is the point.
 */
@Injectable()
export class TenantKeyService {
  private readonly cache = new Map<string, { key: Buffer; expiresAt: number }>();
  private static readonly TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async get(tenantId: string): Promise<Buffer> {
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.key;

    // The tenant row is itself behind RLS, so it must be read with the tenant
    // context set — there is no privileged read path, by design.
    const wrapped = await this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<{ dataKeyEnc: string | null }[]>`
        SELECT "dataKeyEnc" FROM tenant WHERE id = ${tenantId}::uuid
      `;
      return rows[0]?.dataKeyEnc ?? null;
    });

    if (!wrapped) {
      throw new InternalServerErrorException(
        `Tenant ${tenantId} has no data-encryption key. It was provisioned incorrectly ` +
          `and cannot store or read encrypted fields.`,
      );
    }

    const key = this.crypto.unwrapTenantKey(tenantId, wrapped);
    this.cache.set(tenantId, { key, expiresAt: Date.now() + TenantKeyService.TTL_MS });
    return key;
  }

  /** Call on tenant suspension or key rotation. */
  evict(tenantId: string): void {
    this.cache.delete(tenantId);
    this.crypto.evictTenantKey(tenantId);
  }
}
