import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { VersioningType, type INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import type { Request } from 'express';
import { json } from 'express';
import { AppModule } from './app.module';
import { CONFIG, type AppConfig } from './config/configuration';

/**
 * Everything that configures the application, shared by both entry points.
 *
 * There are two: `main.ts` for a long-lived container, and `api/index.ts` for a
 * serverless host. They must not drift — a security header or a CORS rule
 * applied in one and forgotten in the other is exactly the kind of difference
 * nobody notices until it matters, so the configuration lives here once and
 * neither entry point is allowed its own copy.
 *
 * The only thing this does NOT do is listen. That is the actual difference
 * between the two, and it is the caller's job.
 */
export async function createApp(): Promise<{ app: INestApplication; config: AppConfig }> {
  const app = await NestFactory.create(AppModule, {
    // Body is buffered so DeviceAuthGuard can verify the HMAC over the exact
    // bytes received. Re-serialising a parsed object would change whitespace
    // and key order, and the signature would never match.
    bodyParser: false,
    logger: ['error', 'warn', 'log'],
  });

  const config = app.get<AppConfig>(CONFIG);

  app.use(
    json({
      limit: '2mb',
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: config.NODE_ENV === 'production' ? undefined : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: config.NODE_ENV === 'production' ? { maxAge: 31536000, preload: true } : false,
    }),
  );

  app.enableCors({
    origin: config.CORS_ORIGINS,
    credentials: true,
    exposedHeaders: ['x-request-id'],
  });

  // Behind a load balancer, so req.ip reflects the real client rather than the
  // proxy. Without this the audit trail would record every action as coming
  // from the same internal address.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  return { app, config };
}
