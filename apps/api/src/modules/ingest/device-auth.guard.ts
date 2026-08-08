import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { hmacSha256, safeEqual, sha256 } from '@labsetu/crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { TenantKeyService } from '../../common/crypto/tenant-key.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * Authenticates the on-prem gateway.
 *
 * The gateway sits in a network we do not control, on a machine that also talks
 * to unpatchable analyzers, so authentication is layered rather than singular:
 *
 *   x-device-id        which device is claiming to speak
 *   x-device-key       bearer credential, compared against a stored hash
 *   x-timestamp        rejected outside ±5 minutes (replay window)
 *   x-nonce            single-use within that window
 *   x-signature        HMAC-SHA256 over timestamp.nonce.body
 *
 * The body signature is what matters most: a stolen key alone cannot be used to
 * inject a fabricated patient result, because the attacker also needs the HMAC
 * secret, which is never transmitted.
 *
 * In production this additionally runs over mTLS with a per-device client
 * certificate.
 */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  /**
   * Seen nonces, in memory. Adequate for a single instance; production moves
   * this to Redis so replay protection survives a restart and spans instances.
   */
  private readonly seenNonces = new Map<string, number>();
  private static readonly SKEW_MS = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly tenantKeys: TenantKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();

    const deviceId = req.header('x-device-id');
    const deviceKey = req.header('x-device-key');
    const timestamp = req.header('x-timestamp');
    const nonce = req.header('x-nonce');
    const signature = req.header('x-signature');

    if (!deviceId || !deviceKey || !timestamp || !nonce || !signature) {
      throw new UnauthorizedException('Missing device authentication headers');
    }

    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > DeviceAuthGuard.SKEW_MS) {
      throw new UnauthorizedException(
        'Request timestamp is outside the accepted window — check the gateway machine clock',
      );
    }

    this.pruneNonces();
    const nonceKey = `${deviceId}:${nonce}`;
    if (this.seenNonces.has(nonceKey)) {
      throw new UnauthorizedException('Replayed request');
    }

    // The device row is behind RLS, so it is looked up without tenant context
    // via a targeted platform query on the key hash — the hash is the only thing
    // that identifies which tenant to scope to in the first place.
    const device = await this.prisma.asPlatform(async (c) => {
      const rows = await c.$queryRaw<
        {
          id: string;
          tenant_id: string;
          lab_id: string;
          code: string;
          status: string;
          is_shadow_mode: boolean;
          device_secret_enc: string | null;
        }[]
      >`SELECT * FROM labsetu_resolve_device_by_key(${sha256(deviceKey)}, ${deviceId}::uuid)`;
      const r = rows[0];
      return r
        ? {
            id: r.id,
            tenantId: r.tenant_id,
            labId: r.lab_id,
            code: r.code,
            status: r.status,
            isShadowMode: r.is_shadow_mode,
            deviceSecretEnc: r.device_secret_enc,
          }
        : undefined;
    });

    if (!device) throw new UnauthorizedException('Unknown device credentials');
    if (device.status === 'REVOKED' || device.status === 'DISABLED') {
      throw new UnauthorizedException(`Device ${device.code} is ${device.status.toLowerCase()}`);
    }
    if (!device.deviceSecretEnc) {
      throw new UnauthorizedException('Device has no signing secret — re-enrol it');
    }

    const tenantKey = await this.tenantKeys.get(device.tenantId);
    const secret = this.crypto.decryptField(device.deviceSecretEnc, tenantKey);
    if (!secret) throw new UnauthorizedException('Device signing secret is unreadable');

    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const expected = hmacSha256(secret, `${timestamp}.${nonce}.${rawBody.toString('utf8')}`);

    if (!safeEqual(expected, signature)) {
      throw new UnauthorizedException('Invalid request signature');
    }

    this.seenNonces.set(nonceKey, Date.now());

    const ctx = RequestContextStore.require();
    ctx.tenantId = device.tenantId;
    ctx.deviceId = device.id;
    ctx.userDisplay = `Device ${device.code}`;
    ctx.userRole = 'DEVICE';

    (req as Request & { device?: unknown }).device = device;

    return true;
  }

  private pruneNonces(): void {
    const cutoff = Date.now() - DeviceAuthGuard.SKEW_MS * 2;
    for (const [k, t] of this.seenNonces) {
      if (t < cutoff) this.seenNonces.delete(k);
    }
  }
}
