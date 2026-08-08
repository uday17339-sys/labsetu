import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaClient, Prisma } from '@labsetu/db';
import { RequestContextStore } from '../context/request-context';

/**
 * Database access, scoped to a tenant by PostgreSQL RLS (ADR 0002).
 *
 * The important rule: domain services use `prisma.tx`, never `prisma.raw`.
 * `tx` is the transaction that already has `app.tenant_id` set, so RLS applies.
 * `raw` bypasses nothing at the DB level, but it has no tenant context, which
 * means every query returns zero rows — the failure is loud rather than leaky.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly client: PrismaClient;

  constructor() {
    this.client = new PrismaClient({
      log:
        process.env.NODE_ENV === 'development'
          ? [{ emit: 'event', level: 'query' }, 'warn', 'error']
          : ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  /**
   * The tenant-scoped transaction client for the current request.
   *
   * Throws rather than silently falling back to an unscoped client — a fallback
   * would turn "developer forgot the interceptor" into "queries run without
   * tenant context", which is exactly the class of bug RLS exists to prevent.
   */
  get tx(): Prisma.TransactionClient {
    const ctx = RequestContextStore.get();
    if (!ctx?.tx) {
      throw new InternalServerErrorException(
        'No tenant-scoped transaction on this request. The route is missing ' +
          'TenantTransactionInterceptor, or this code is running outside a request.',
      );
    }
    return ctx.tx;
  }

  /** Escape hatch for genuinely tenant-less work: health checks, migrations. */
  get unsafeGlobal(): PrismaClient {
    return this.client;
  }

  /**
   * Runs `fn` inside a transaction with `app.tenant_id` set.
   *
   * `set_config(..., true)` makes the setting LOCAL to the transaction, so it is
   * discarded on commit and cannot leak to the next request that borrows this
   * pooled connection. Getting that third argument wrong would be a silent
   * cross-tenant bug, which is why it is written once, here.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { timeout?: number; maxWait?: number } = {},
  ): Promise<T> {
    return this.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return fn(tx);
      },
      {
        timeout: options.timeout ?? 20_000,
        maxWait: options.maxWait ?? 10_000,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    );
  }

  /**
   * Reserved for platform operations that legitimately span tenants: tenant
   * provisioning, the nightly audit-chain verifier, retention sweeps.
   *
   * Every caller must be individually justifiable to an auditor, so the list of
   * call sites is deliberately kept short and reviewed.
   */
  async asPlatform<T>(fn: (client: PrismaClient) => Promise<T>): Promise<T> {
    return fn(this.client);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
