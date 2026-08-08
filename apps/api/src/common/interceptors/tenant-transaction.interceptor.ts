import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContextStore } from '../context/request-context';

/**
 * Opens one interactive transaction per request with `app.tenant_id` set, so
 * PostgreSQL RLS scopes every query the handler makes (ADR 0002).
 *
 * The transaction also spans the audit write, which is the property that makes
 * "a data change always has an audit entry" a database guarantee rather than a
 * code convention: they commit together or neither does.
 *
 * KNOWN TRADEOFF (documented, not discovered): a request holds a pooled
 * connection for its full lifetime, so concurrency is bounded by pool size and
 * slow endpoints are expensive. Accepted for the isolation and atomicity it
 * buys. Revisit at p99/pool-saturation pressure — ADR 0002 records the escape
 * hatch.
 */
@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = RequestContextStore.get();

    // Unauthenticated routes (login, health) have no tenant yet and run without
    // a transaction. They must not touch tenant data — PrismaService.tx throws
    // if they try, which turns a would-be leak into a loud 500.
    if (!ctx?.tenantId) {
      return next.handle();
    }

    // Nested interceptor invocation would open a second transaction on a second
    // connection; the inner one could not see the outer one's uncommitted work.
    if (ctx.tx) {
      return next.handle();
    }

    return from(
      this.prisma.withTenant(ctx.tenantId, async (tx) => {
        ctx.tx = tx;
        try {
          // firstValueFrom-equivalent: run the handler chain to completion
          // inside the transaction so a thrown error rolls everything back,
          // audit entry included.
          return await new Promise((resolve, reject) => {
            next.handle().subscribe({
              next: resolve,
              error: reject,
            });
          });
        } finally {
          ctx.tx = undefined;
        }
      }),
    );
  }
}
