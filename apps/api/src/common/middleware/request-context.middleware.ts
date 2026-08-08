import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { RequestContextStore, createRequestContext } from '../context/request-context';

/**
 * Establishes the per-request AsyncLocalStorage store. Runs before guards, so
 * everything downstream — auth, RLS scoping, audit — can rely on it existing.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Accept an inbound correlation id so a trace spans web -> api, but only
    // if it looks like one. An unvalidated header ends up in logs and audit
    // records, so it is treated as untrusted input.
    const incoming = req.header('x-request-id');
    const requestId =
      incoming && /^[A-Za-z0-9._-]{1,128}$/.test(incoming) ? incoming : randomUUID();

    const ctx = createRequestContext({
      requestId,
      ip: clientIp(req),
      userAgent: req.header('user-agent')?.slice(0, 500),
      method: req.method,
      path: req.path,
    });

    res.setHeader('x-request-id', requestId);

    RequestContextStore.run(ctx, () => next());
  }
}

/**
 * Trusts X-Forwarded-For only when Express itself is configured to (`trust
 * proxy`). Otherwise any client could forge its own IP into the audit trail,
 * which would make the attribution guarantee worthless.
 */
function clientIp(req: Request): string | undefined {
  return (req.ip ?? req.socket.remoteAddress ?? undefined)?.replace(/^::ffff:/, '');
}
