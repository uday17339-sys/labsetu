import { Controller, Get, Inject, Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Public } from '../../common/rbac/permissions.decorator';
import { CONFIG, type AppConfig } from '../../config/configuration';

@Controller()
class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Liveness: is the process up? Deliberately does not touch the database. */
  @Public()
  @Get('health')
  health() {
    return { status: 'ok', uptime: Math.floor(process.uptime()) };
  }

  /**
   * Readiness: can it actually serve traffic? Reports the residency region so a
   * misconfigured deployment is visible from outside, not just in the logs.
   */
  @Public()
  @Get('ready')
  async ready() {
    const db = await this.prisma.healthCheck();
    return {
      status: db ? 'ok' : 'degraded',
      checks: { database: db ? 'up' : 'down' },
      region: this.config.DATA_RESIDENCY_REGION,
      version: process.env.npm_package_version ?? '0.1.0',
    };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
