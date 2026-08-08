import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  instrumentEnvelopeSchema,
  enrolDeviceSchema,
  heartbeatSchema,
  PERMISSIONS,
} from '@labsetu/contracts';
import { randomToken, sha256, randomEnrolmentCode } from '@labsetu/crypto';
import { IngestService } from './ingest.service';
import { DeviceAuthGuard } from './device-auth.guard';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { TenantKeyService } from '../../common/crypto/tenant-key.service';
import { DeviceAuth, Public, RequirePermissions } from '../../common/rbac/permissions.decorator';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { RequestContextStore } from '../../common/context/request-context';

@Injectable()
class DeviceEnrolmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly tenantKeys: TenantKeyService,
  ) {}

  /**
   * Exchanges a one-time enrolment code for device credentials.
   *
   * The secret is returned exactly once and stored only as ciphertext. If it is
   * lost the device must be re-enrolled — recoverable credentials would mean a
   * database read yields the ability to inject patient results.
   */
  async enrol(enrolmentCode: string, gatewayVersion: string, hostname?: string) {
    const device = await this.prisma.asPlatform(async (c) => {
      const rows = await c.$queryRaw<
        {
          id: string;
          tenant_id: string;
          lab_id: string;
          code: string;
          status: string;
          is_shadow_mode: boolean;
          enrolment_expires_at: Date | null;
        }[]
      >`SELECT * FROM labsetu_resolve_device_by_enrolment(${enrolmentCode})`;
      const r = rows[0];
      return r
        ? {
            id: r.id,
            tenantId: r.tenant_id,
            labId: r.lab_id,
            code: r.code,
            status: r.status,
            isShadowMode: r.is_shadow_mode,
            enrolmentCodeExpiresAt: r.enrolment_expires_at,
          }
        : undefined;
    });

    if (!device) throw new BadRequestException('Invalid enrolment code');
    if (device.enrolmentCodeExpiresAt && device.enrolmentCodeExpiresAt < new Date()) {
      throw new BadRequestException('Enrolment code has expired — ask an administrator for a new one');
    }

    const deviceKey = randomToken(32);
    const deviceSecret = randomToken(32);

    return this.prisma.withTenant(device.tenantId, async (tx) => {
      const tenantKey = await this.tenantKeys.get(device.tenantId);

      await tx.device.update({
        where: { id: device.id },
        data: {
          deviceKeyHash: sha256(deviceKey),
          deviceSecretEnc: this.crypto.encryptField(deviceSecret, tenantKey),
          status: device.status === 'PENDING_ENROLMENT' ? 'ENROLLED' : (device.status as never),
          enrolledAt: new Date(),
          // Burn the code so it cannot be replayed by anyone who saw it.
          enrolmentCode: null,
          lastSeenAt: new Date(),
        },
      });

      await this.audit.record(tx, {
        tenantId: device.tenantId,
        actorDeviceId: device.id,
        action: 'DEVICE_ENROLLED',
        entityType: 'Device',
        entityId: device.id,
        after: { code: device.code, gatewayVersion, hostname: hostname ?? null },
      });

      return {
        deviceId: device.id,
        deviceKey,
        deviceSecret,
        tenantId: device.tenantId,
        labId: device.labId,
        deviceCode: device.code,
        isShadowMode: device.isShadowMode,
      };
    });
  }

  /** Rotates the enrolment code for a device, for an administrator to read out. */
  async issueEnrolmentCode(deviceId: string) {
    const tx = this.prisma.tx;
    const code = randomEnrolmentCode();

    const device = await tx.device.update({
      where: { id: deviceId },
      data: {
        enrolmentCode: code,
        enrolmentCodeExpiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'Device',
      entityId: deviceId,
      after: { code: device.code, enrolmentCodeIssued: true, expiresInHours: 24 },
    });

    return { deviceCode: device.code, enrolmentCode: code, expiresInHours: 24 };
  }
}

@Controller({ path: 'ingest', version: '1' })
class IngestController {
  constructor(
    private readonly ingest: IngestService,
    private readonly enrolment: DeviceEnrolmentService,
  ) {}

  /** One-time enrolment. Public because the gateway has no credentials yet. */
  @Public()
  @HttpCode(200)
  @Post('enrol')
  enrol(@Body(zodPipe(enrolDeviceSchema)) body: { enrolmentCode: string; gatewayVersion: string; hostname?: string }) {
    return this.enrolment.enrol(body.enrolmentCode, body.gatewayVersion, body.hostname);
  }

  /** The single ingest contract. Every analyzer protocol reduces to this. */
  @DeviceAuth()
  @UseGuards(DeviceAuthGuard)
  @HttpCode(202)
  @Post('messages')
  async receive(@Body(zodPipe(instrumentEnvelopeSchema)) body: never, @Req() req: Request & { device: { id: string; tenantId: string; isShadowMode: boolean } }) {
    return this.ingest.ingest(body, req.device);
  }

  /**
   * Heartbeat. A silent analyzer is an alert — "we didn't notice it stopped
   * sending" is the failure mode that actually bites labs.
   */
  @DeviceAuth()
  @UseGuards(DeviceAuthGuard)
  @HttpCode(200)
  @Post('heartbeat')
  async heartbeat(
    @Body(zodPipe(heartbeatSchema)) body: { outboxDepth: number; gatewayVersion: string },
    @Req() req: Request & { device: { id: string } },
  ) {
    const ctx = RequestContextStore.require();
    await this.ingest['prisma'].tx.device.update({
      where: { id: req.device.id },
      data: { lastSeenAt: new Date() },
    });
    return { acknowledged: true, serverTime: new Date().toISOString(), requestId: ctx.requestId };
  }

  // --- operator-facing ------------------------------------------------------

  /** Instrument health: which analysers are talking to us, and which stopped. */
  @RequirePermissions(PERMISSIONS.DEVICE_READ)
  @Get('devices')
  devices() {
    return this.ingest.listDevices();
  }

  @RequirePermissions(PERMISSIONS.DEVICE_ENROL)
  @Post('devices/:id/enrolment-code')
  issueCode(@Param('id', ParseUUIDPipe) id: string) {
    return this.enrolment.issueEnrolmentCode(id);
  }

  /** The held queue: unmatched results awaiting a human decision. */
  @RequirePermissions(PERMISSIONS.INGEST_EXCEPTION_RESOLVE)
  @Get('exceptions')
  exceptions(@Query('status') status = 'OPEN', @Query('limit') limit = '50') {
    return this.ingest.listExceptions(status, Math.min(Number(limit) || 50, 200));
  }

  @RequirePermissions(PERMISSIONS.INGEST_EXCEPTION_RESOLVE)
  @Post('exceptions/:id/resolve')
  resolve(@Param('id', ParseUUIDPipe) id: string, @Body() body: { note: string }) {
    return this.ingest.resolveException(id, body.note ?? 'Reviewed');
  }
}

@Module({
  controllers: [IngestController],
  providers: [IngestService, DeviceEnrolmentService, DeviceAuthGuard],
  exports: [IngestService],
})
export class IngestModule {}
