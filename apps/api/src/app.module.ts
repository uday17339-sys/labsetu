import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CommonModule } from './common/common.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { PatientsModule } from './modules/patients/patients.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { ReportsModule } from './modules/reports/reports.module';
import { IngestModule } from './modules/ingest/ingest.module';
import { QcModule } from './modules/qc/qc.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { StoresModule } from './modules/stores/stores.module';
import { BillingModule } from './modules/billing/billing.module';
import { AdminModule } from './modules/admin/admin.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { HealthModule } from './modules/health/health.module';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/rbac/permissions.guard';
import { TenantTransactionInterceptor } from './common/interceptors/tenant-transaction.interceptor';
import { ProblemDetailFilter } from './common/filters/problem-detail.filter';
import { CONFIG, type AppConfig } from './config/configuration';
import { QualityModule } from './modules/quality/quality.module';
import { StabilityModule } from './modules/stability/stability.module';

@Module({
  imports: [
    CommonModule,
    ThrottlerModule.forRootAsync({
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.RATE_LIMIT_TTL_SECONDS * 1000,
            limit: config.RATE_LIMIT_MAX,
          },
          // Auth endpoints get their own, much tighter bucket — see the
          // @Throttle({ auth: ... }) decorators on AuthController.
          { name: 'auth', ttl: 60_000, limit: config.AUTH_RATE_LIMIT_MAX },
        ],
      }),
    }),
    AuthModule,
    QualityModule,
    StabilityModule,
    CatalogModule,
    PatientsModule,
    WorkflowModule,
    ReportsModule,
    IngestModule,
    QcModule,
    InventoryModule,
    StoresModule,
    BillingModule,
    AdminModule,
    ComplianceModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailFilter },

    // ORDER MATTERS. Guards run top to bottom:
    //   1. rate limit    — cheapest rejection first
    //   2. authenticate  — establishes tenant + actor in the request context
    //   3. authorise     — deny-by-default permission check
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },

    // Runs after guards, so the tenant is known before the transaction opens.
    { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Before everything, including guards: nothing downstream should run
    // without a request context.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
