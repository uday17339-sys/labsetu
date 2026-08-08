import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@labsetu/db';

/**
 * Per-request state carried implicitly through the call stack.
 *
 * The alternative — threading `tx`, `tenantId` and `actor` through every service
 * signature — is what causes tenant filters and audit entries to get dropped: it
 * only takes one function that forgot to pass them along. AsyncLocalStorage
 * makes it impossible to be in a request and not have the context.
 */
export interface RequestContext {
  requestId: string;
  startedAt: number;

  /** Set once authentication succeeds. */
  tenantId?: string;
  userId?: string;
  userDisplay?: string;
  /** Role at the time of the action — roles change, audit records must not. */
  userRole?: string;
  permissions: Set<string>;

  /** Set instead of userId for gateway-originated requests. */
  deviceId?: string;

  ip?: string;
  userAgent?: string;
  method?: string;
  path?: string;

  /**
   * The tenant-scoped transaction client, opened by TenantTransactionInterceptor
   * with app.tenant_id already set. Domain services read this rather than the
   * bare PrismaClient — using the bare client would bypass tenant scoping.
   */
  tx?: Prisma.TransactionClient;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const RequestContextStore = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },

  /** Returns undefined outside a request (workers, bootstrap, tests). */
  get(): RequestContext | undefined {
    return storage.getStore();
  },

  /** Throws outside a request — for code paths that genuinely require one. */
  require(): RequestContext {
    const ctx = storage.getStore();
    if (!ctx) {
      throw new Error(
        'No request context. This code path must run inside an HTTP request, ' +
          'or be given an explicit context (see WorkerContext for queue jobs).',
      );
    }
    return ctx;
  },

  set<K extends keyof RequestContext>(key: K, value: RequestContext[K]): void {
    const ctx = storage.getStore();
    if (ctx) ctx[key] = value;
  },
};

export function createRequestContext(init: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: init.requestId ?? crypto.randomUUID(),
    startedAt: Date.now(),
    permissions: init.permissions ?? new Set<string>(),
    ...init,
  };
}
