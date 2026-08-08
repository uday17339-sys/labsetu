import { Global, Module, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { AuditService } from './audit/audit.service';
import { CryptoService } from './crypto/crypto.service';
import { TenantKeyService } from './crypto/tenant-key.service';
import { CONFIG, loadConfig } from '../config/configuration';

/**
 * Global infrastructure: config, database, audit, crypto.
 *
 * Global because these are true cross-cutting concerns — a domain module that
 * had to remember to import AuditService is a domain module that will one day
 * forget to.
 */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    PrismaService,
    AuditService,
    CryptoService,
    TenantKeyService,
  ],
  exports: [CONFIG, PrismaService, AuditService, CryptoService, TenantKeyService],
})
export class CommonModule implements OnModuleInit {
  constructor(
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    // Wired here rather than by constructor injection: AuditService taking
    // PrismaService directly would close a dependency cycle. See
    // AuditService.recordIndependent for why it needs its own transaction.
    this.audit.setTransactionRunner((tenantId, fn) => this.prisma.withTenant(tenantId, fn));
  }
}
