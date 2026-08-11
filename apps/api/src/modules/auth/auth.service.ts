import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { hashPassword, verifyPassword, burnTiming, randomToken, sha256 } from '@labsetu/crypto';
import type { LoginInput, LoginResponse, SigningTokenRequest } from '@labsetu/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { TenantKeyService } from '../../common/crypto/tenant-key.service';
import { RequestContextStore } from '../../common/context/request-context';
import { CONFIG, type AppConfig } from '../../config/configuration';
import { Prisma } from '@labsetu/db';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly tenantKeys: TenantKeyService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  /**
   * Password (+ TOTP) sign-in.
   *
   * Structured so the transaction NEVER writes on a failure path. A rejected
   * login rolls its transaction back, so an audit entry or a lockout counter
   * written inside it would vanish — meaning a brute-force attempt would leave
   * no trace and never trigger lockout. Failures therefore return an outcome,
   * and the recording happens afterwards in its own committed transaction.
   */
  async login(input: LoginInput): Promise<LoginResponse> {
    // Bootstrap lookup: we have a tenant CODE but need the tenant ID before any
    // tenant context can be set. Goes through the narrow SECURITY DEFINER
    // function rather than a raw cross-tenant read — see security.sql §3b.
    const tenant = await this.prisma.asPlatform(async (c) => {
      const rows = await c.$queryRaw<
        { id: string; code: string; name: string; status: string }[]
      >`SELECT * FROM labsetu_resolve_tenant(${input.tenantCode})`;
      return rows[0];
    });

    // Burn the same work whether or not the tenant exists, so response timing
    // does not enumerate customer codes.
    if (!tenant || tenant.status !== 'ACTIVE') {
      await burnTiming(input.password);
      throw new UnauthorizedException('Invalid credentials');
    }

    const outcome = await this.prisma.withTenant(tenant.id, async (tx) => {
      const user = await tx.user.findFirst({
        where: { email: input.email },
        include: { roles: { include: { role: true, lab: true } } },
      });

      if (!user) {
        await burnTiming(input.password);
        return {
          kind: 'FAIL' as const,
          reason: 'UNKNOWN_USER',
          message: 'Invalid credentials',
          countFailure: false,
          attemptedEmail: input.email,
        };
      }

      if (user.lockedUntil && user.lockedUntil > new Date()) {
        return {
          kind: 'FAIL' as const,
          reason: 'ACCOUNT_LOCKED',
          message: `Account locked until ${user.lockedUntil.toISOString()} after repeated failed sign-ins`,
          countFailure: false,
          userId: user.id,
          userName: user.fullName,
        };
      }

      if (user.status !== 'ACTIVE') {
        return {
          kind: 'FAIL' as const,
          reason: 'ACCOUNT_INACTIVE',
          message: 'Account is not active',
          countFailure: false,
          userId: user.id,
          userName: user.fullName,
        };
      }

      if (!(await verifyPassword(user.passwordHash, input.password))) {
        return {
          kind: 'FAIL' as const,
          reason: 'BAD_PASSWORD',
          message: 'Invalid credentials',
          countFailure: true,
          userId: user.id,
          userName: user.fullName,
        };
      }

      // --- MFA ---------------------------------------------------------------
      if (user.isMfaEnabled) {
        if (!input.totpCode) {
          // First leg. The MFA token proves the password step succeeded and is
          // exchangeable for nothing except a completed login.
          const mfaToken = await this.jwt.signAsync(
            { sub: user.id, tid: tenant.id, purpose: 'mfa' },
            { expiresIn: '5m' },
          );
          return {
            kind: 'MFA' as const,
            response: { status: 'MFA_REQUIRED' as const, mfaToken },
          };
        }

        const secret = this.crypto.decryptField(
          user.mfaSecretEnc,
          await this.tenantKeys.get(tenant.id),
        );
        if (!secret || !this.verifyTotp(secret, input.totpCode)) {
          return {
            kind: 'FAIL' as const,
            reason: 'BAD_TOTP',
            message: 'Invalid authentication code',
            countFailure: true,
            userId: user.id,
            userName: user.fullName,
          };
        }
      }

      // --- success -----------------------------------------------------------
      await tx.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
      });

      const permissions = [...new Set(user.roles.flatMap((ur) => ur.role.permissions))];
      const roleCodes = user.roles.map((ur) => ur.role.code);
      const labs = await tx.lab.findMany({
        where: { isActive: true },
        select: { id: true, code: true, name: true },
      });

      const { accessToken, refreshToken, expiresIn } = await this.issueSession(tx, {
        userId: user.id,
        tenantId: tenant.id,
        tokenVersion: user.tokenVersion,
        fullName: user.fullName,
        role: roleCodes[0] ?? 'UNKNOWN',
        permissions,
        labIds: labs.map((l) => l.id),
      });

      await this.audit.record(tx, {
        tenantId: tenant.id,
        action: 'LOGIN_SUCCESS',
        entityType: 'User',
        entityId: user.id,
        actorUserId: user.id,
        actorDisplay: user.fullName,
        actorRole: roleCodes[0],
        after: { mfaUsed: user.isMfaEnabled },
      });

      // §11.300(b): passwords age out. Rather than refusing the sign-in — which
      // strands someone mid-shift with no way to fix it — the session is issued
      // and flagged as requiring a change, which is the same path a first
      // sign-in already takes. The client cannot ignore it: every screen behind
      // the change-password gate checks the same flag.
      const maxAgeDays = await this.policy(tx, 'password.maxAgeDays', 90);
      const passwordExpired =
        maxAgeDays > 0 &&
        Date.now() - user.passwordChangedAt.getTime() > maxAgeDays * 864e5;

      if (passwordExpired) {
        await this.audit.record(tx, {
          tenantId: tenant.id,
          action: 'PASSWORD_EXPIRED',
          entityType: 'User',
          entityId: user.id,
          actorUserId: user.id,
          actorDisplay: user.fullName,
          after: {
            passwordChangedAt: user.passwordChangedAt.toISOString(),
            maxAgeDays,
          },
        });
      }

      return {
        kind: 'OK' as const,
        response: {
          status: 'OK' as const,
          accessToken,
          refreshToken,
          expiresIn,
          user: {
            id: user.id,
            email: user.email,
            fullName: user.fullName,
            tenantId: tenant.id,
            tenantCode: tenant.code,
            tenantName: tenant.name,
            permissions,
            roles: roleCodes,
            labs,
            isMfaEnabled: user.isMfaEnabled,
            mustChangePassword: user.mustChangePassword || passwordExpired,
            locale: user.locale,
          },
        },
      };
    });

    if (outcome.kind === 'FAIL') {
      await this.recordLoginFailure(tenant.id, outcome);
      throw new UnauthorizedException(outcome.message);
    }

    return outcome.response;
  }

  /**
   * Commits the lockout counter and the audit entry for a failed sign-in, in a
   * transaction of its own so neither is lost to the rollback of the rejected
   * request.
   */
  private async recordLoginFailure(
    tenantId: string,
    outcome: {
      reason: string;
      countFailure: boolean;
      userId?: string;
      userName?: string;
      attemptedEmail?: string;
    },
  ): Promise<void> {
    try {
      await this.prisma.withTenant(tenantId, async (tx) => {
        let failedCount: number | null = null;
        let locked = false;

        if (outcome.countFailure && outcome.userId) {
          const current = await tx.user.findUnique({
            where: { id: outcome.userId },
            select: { failedLoginCount: true },
          });
          failedCount = (current?.failedLoginCount ?? 0) + 1;
          locked = failedCount >= MAX_FAILED_LOGINS;

          await tx.user.update({
            where: { id: outcome.userId },
            data: {
              failedLoginCount: failedCount,
              lockedUntil: locked ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
            },
          });
        }

        await this.audit.record(tx, {
          tenantId,
          action: 'LOGIN_FAILURE',
          entityType: 'User',
          entityId: outcome.userId ?? null,
          actorUserId: outcome.userId ?? null,
          actorDisplay: outcome.userName ?? null,
          after: {
            reason: outcome.reason,
            // The attempted address is recorded only when no user matched, so
            // an operator can see enumeration attempts. It is not PHI.
            attemptedEmail: outcome.attemptedEmail ?? null,
            failedCount,
            locked,
          },
        });
      });
    } catch (err) {
      this.logger.error(
        `Failed to record login failure: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Refresh with rotation + reuse detection
  // ---------------------------------------------------------------------------

  /**
   * Rotates the refresh token. Presenting one that has already been rotated is
   * treated as theft — the whole family is revoked, which logs out both the
   * attacker and the legitimate user. Being logged out is the correct outcome
   * when a token has demonstrably leaked.
   */
  async refresh(presented: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    const tokenHash = sha256(presented);

    // Same bootstrap problem: an opaque token must resolve to a tenant first.
    const stored = await this.prisma.asPlatform(async (c) => {
      const rows = await c.$queryRaw<
        {
          id: string;
          tenant_id: string;
          user_id: string;
          family_id: string;
          expires_at: Date;
          revoked_at: Date | null;
        }[]
      >`SELECT * FROM labsetu_resolve_refresh_token(${tokenHash})`;
      const r = rows[0];
      return r
        ? {
            id: r.id,
            tenantId: r.tenant_id,
            userId: r.user_id,
            familyId: r.family_id,
            expiresAt: r.expires_at,
            revokedAt: r.revoked_at,
          }
        : undefined;
    });

    if (!stored) throw new UnauthorizedException('Invalid refresh token');

    return this.prisma.withTenant(stored.tenantId, async (tx) => {
      if (stored.revokedAt) {
        await tx.refreshToken.updateMany({
          where: { familyId: stored.familyId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'REUSE_DETECTED' },
        });
        await tx.user.update({
          where: { id: stored.userId },
          data: { tokenVersion: { increment: 1 } },
        });
        await this.audit.record(tx, {
          tenantId: stored.tenantId,
          action: 'TOKEN_REUSE_DETECTED',
          entityType: 'RefreshToken',
          entityId: stored.id,
          actorUserId: stored.userId,
          after: { familyId: stored.familyId, allSessionsRevoked: true },
        });
        this.logger.warn(
          `Refresh token reuse detected for user ${stored.userId} — family revoked`,
        );
        throw new UnauthorizedException('Session invalidated. Please sign in again.');
      }

      if (stored.expiresAt < new Date()) {
        throw new UnauthorizedException('Refresh token expired');
      }

      const user = await tx.user.findUniqueOrThrow({
        where: { id: stored.userId },
        include: { roles: { include: { role: true } } },
      });

      if (user.status !== 'ACTIVE') throw new UnauthorizedException('Account is not active');

      await tx.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date(), revokedReason: 'ROTATED' },
      });

      const labs = await tx.lab.findMany({ where: { isActive: true }, select: { id: true } });

      return this.issueSession(tx, {
        userId: user.id,
        tenantId: stored.tenantId,
        tokenVersion: user.tokenVersion,
        fullName: user.fullName,
        role: user.roles[0]?.role.code ?? 'UNKNOWN',
        permissions: [...new Set(user.roles.flatMap((ur) => ur.role.permissions))],
        labIds: labs.map((l) => l.id),
        familyId: stored.familyId,
        parentId: stored.id,
      });
    });
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = sha256(refreshToken);
    const stored = await this.prisma.asPlatform(async (c) => {
      const rows = await c.$queryRaw<
        { id: string; tenant_id: string }[]
      >`SELECT id, tenant_id FROM labsetu_resolve_refresh_token(${tokenHash})`;
      const r = rows[0];
      return r ? { id: r.id, tenantId: r.tenant_id } : undefined;
    });
    if (!stored) return;

    await this.prisma.withTenant(stored.tenantId, async (tx) => {
      await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
      });
      await this.audit.record(tx, {
        tenantId: stored.tenantId,
        action: 'LOGOUT',
        entityType: 'RefreshToken',
        entityId: stored.id,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Electronic signature: re-authentication at the point of signing
  // ---------------------------------------------------------------------------

  /**
   * Issues a signing token bound to one entity AND one content hash.
   *
   * The content binding is what makes the signature meaningful: it proves what
   * was signed, so a value edited after signing is detectable rather than
   * silently inheriting the signature. Single-use and 5-minute expiry stop a
   * captured token being replayed against a different record.
   */
  async issueSigningToken(
    req: SigningTokenRequest,
  ): Promise<{ signingToken: string; expiresIn: number }> {
    const ctx = RequestContextStore.require();
    const { tenantId, userId } = ctx;
    if (!tenantId || !userId) throw new UnauthorizedException();

    const user = await this.prisma.tx.user.findUniqueOrThrow({ where: { id: userId } });

    const passwordOk = await verifyPassword(user.passwordHash, req.password);
    if (!passwordOk) {
      await this.audit.record(this.prisma.tx, {
        action: 'LOGIN_FAILURE',
        entityType: 'Signature',
        entityId: req.entityId,
        after: { reason: 'SIGNING_BAD_PASSWORD', entityType: req.entityType },
      });
      throw new UnauthorizedException('Password is incorrect');
    }

    // Two distinct identification components, as e-signature regimes require.
    if (user.isMfaEnabled) {
      if (!req.totpCode) {
        throw new BadRequestException('An authentication code is required to sign');
      }
      const secret = this.crypto.decryptField(
        user.mfaSecretEnc,
        await this.tenantKeys.get(tenantId),
      );
      if (!secret || !this.verifyTotp(secret, req.totpCode)) {
        throw new UnauthorizedException('Invalid authentication code');
      }
    }

    const jti = randomUUID();
    const signingToken = await this.jwt.signAsync(
      {
        sub: userId,
        tid: tenantId,
        purpose: 'signing',
        jti,
        ent: req.entityType,
        eid: req.entityId,
        meaning: req.meaning,
        chash: req.contentHash,
      },
      { expiresIn: this.config.SIGNING_TOKEN_TTL_SECONDS },
    );

    return { signingToken, expiresIn: this.config.SIGNING_TOKEN_TTL_SECONDS };
  }

  /**
   * Validates a signing token against the entity and content actually being
   * signed. Every mismatch is a hard failure — this is the last checkpoint
   * before an immutable signature row is written.
   */
  async consumeSigningToken(
    token: string,
    expect: { entityType: string; entityId: string; contentHash: string },
  ): Promise<{ userId: string; meaning: string; jti: string }> {
    const ctx = RequestContextStore.require();

    let claims: {
      sub: string;
      tid: string;
      purpose: string;
      jti: string;
      ent: string;
      eid: string;
      meaning: string;
      chash: string;
    };
    try {
      claims = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Signing token is invalid or has expired');
    }

    if (claims.purpose !== 'signing') throw new UnauthorizedException('Not a signing token');
    if (claims.tid !== ctx.tenantId) throw new ForbiddenException('Signing token tenant mismatch');
    if (claims.sub !== ctx.userId) {
      throw new ForbiddenException('Signing token belongs to a different user');
    }
    if (claims.ent !== expect.entityType || claims.eid !== expect.entityId) {
      throw new ForbiddenException('Signing token was issued for a different record');
    }
    if (claims.chash !== expect.contentHash) {
      // The record changed between requesting the signature and applying it.
      throw new ForbiddenException(
        'The record changed after the signature was requested. Review it and sign again.',
      );
    }

    // Replay protection.
    //
    // A signature is the assertion "I, this person, make THIS statement about
    // THIS content" — so identity is (user, record, content, MEANING). Meaning
    // is load-bearing and was missing here: a pathologist who released a report
    // and then had to amend it was refused, because amendment is requested
    // BEFORE the correction is made and therefore covers the same content that
    // was just released. Releasing and amending are two different assertions
    // over identical bytes, and both are legitimate.
    //
    // Narrowing by meaning keeps the control that matters — the same person
    // cannot make the same assertion about the same content twice, so a
    // captured token cannot be replayed.
    const alreadyUsed = await this.prisma.tx.signature.findFirst({
      where: {
        entityType: expect.entityType,
        entityId: expect.entityId,
        userId: claims.sub,
        meaning: claims.meaning as never,
        contentHash: expect.contentHash,
      },
      select: { id: true, signedAt: true },
    });
    if (alreadyUsed) {
      throw new ForbiddenException(
        `You already signed this exact content as ${claims.meaning.toLowerCase()} at ` +
          `${alreadyUsed.signedAt.toISOString()}. Nothing has changed since, so a second ` +
          `signature would assert nothing new.`,
      );
    }

    return { userId: claims.sub, meaning: claims.meaning, jti: claims.jti };
  }

  // ---------------------------------------------------------------------------
  // MFA enrolment
  // ---------------------------------------------------------------------------

  async beginMfaSetup(): Promise<{
    secret: string;
    otpauthUrl: string;
    recoveryCodes: string[];
  }> {
    const ctx = RequestContextStore.require();
    const user = await this.prisma.tx.user.findUniqueOrThrow({ where: { id: ctx.userId! } });
    const tenant = await this.prisma.tx.tenant.findUniqueOrThrow({
      where: { id: ctx.tenantId! },
      select: { name: true },
    });

    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const totp = new OTPAuth.TOTP({
      issuer: `LabSetu (${tenant.name})`,
      label: user.email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });

    const recoveryCodes = Array.from({ length: 10 }, () => randomToken(6).toUpperCase());

    // Stored but NOT enabled until a code is verified — enabling before proving
    // the authenticator works is how people lock themselves out.
    await this.prisma.tx.user.update({
      where: { id: user.id },
      data: {
        mfaSecretEnc: this.crypto.encryptField(
          secret,
          await this.tenantKeys.get(ctx.tenantId!),
        ),
        mfaRecoveryCodes: recoveryCodes.map((c) => sha256(c)),
      },
    });

    return { secret, otpauthUrl: totp.toString(), recoveryCodes };
  }

  async confirmMfaSetup(totpCode: string): Promise<void> {
    const ctx = RequestContextStore.require();
    const user = await this.prisma.tx.user.findUniqueOrThrow({ where: { id: ctx.userId! } });

    const secret = this.crypto.decryptField(
      user.mfaSecretEnc,
      await this.tenantKeys.get(ctx.tenantId!),
    );
    if (!secret) throw new BadRequestException('Start MFA setup first');
    if (!this.verifyTotp(secret, totpCode)) {
      throw new UnauthorizedException('That code did not match. Check your authenticator app.');
    }

    await this.prisma.tx.user.update({
      where: { id: user.id },
      data: { isMfaEnabled: true },
    });

    await this.audit.record(this.prisma.tx, {
      action: 'MFA_ENABLED',
      entityType: 'User',
      entityId: user.id,
    });
  }

  /**
   * A tenant policy value with a safe default.
   *
   * Takes the transaction explicitly because login runs inside one before a
   * request context exists — the usual `this.prisma.tx` accessor is not
   * available that early.
   */
  private async policy<T>(
    tx: Prisma.TransactionClient,
    key: string,
    fallback: T,
  ): Promise<T> {
    const row = await tx.tenantPolicy.findFirst({ where: { key } });
    return row ? (row.value as T) : fallback;
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const ctx = RequestContextStore.require();
    const user = await this.prisma.tx.user.findUniqueOrThrow({ where: { id: ctx.userId! } });

    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    // §11.300(b): a password change must not cycle back to a recent one.
    // Checked against the stored history AND the current password, because the
    // commonest "change" is re-entering the same one.
    const historyCount = await this.policy(this.prisma.tx, 'password.historyCount', 5);
    if (historyCount > 0) {
      const recent = await this.prisma.tx.passwordHistory.findMany({
        where: { userId: user.id },
        orderBy: { changedAt: 'desc' },
        take: historyCount,
        select: { passwordHash: true },
      });

      const previous = [user.passwordHash, ...recent.map((r) => r.passwordHash)];
      for (const hash of previous) {
        if (await verifyPassword(hash, newPassword)) {
          throw new BadRequestException(
            `This password has been used before. Choose one that is not among your last ` +
              `${historyCount} passwords.`,
          );
        }
      }
    }

    // The outgoing password joins the history before it is replaced.
    await this.prisma.tx.passwordHistory.create({
      data: {
        tenantId: ctx.tenantId!,
        userId: user.id,
        passwordHash: user.passwordHash,
      },
    });

    await this.prisma.tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(newPassword),
        passwordChangedAt: new Date(),
        mustChangePassword: false,
        // Invalidates every outstanding access token for this user.
        tokenVersion: { increment: 1 },
      },
    });

    await this.prisma.tx.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
    });

    await this.audit.record(this.prisma.tx, {
      action: 'PASSWORD_CHANGE',
      entityType: 'User',
      entityId: user.id,
    });
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private async issueSession(
    tx: Parameters<Parameters<PrismaService['withTenant']>[1]>[0],
    input: {
      userId: string;
      tenantId: string;
      tokenVersion: number;
      fullName: string;
      role: string;
      permissions: string[];
      labIds: string[];
      familyId?: string;
      parentId?: string;
    },
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const accessToken = await this.jwt.signAsync({
      sub: input.userId,
      tid: input.tenantId,
      tv: input.tokenVersion,
      name: input.fullName,
      role: input.role,
      perms: input.permissions,
      labs: input.labIds,
    });

    const refreshToken = randomToken(32);
    const expiresAt = new Date(
      Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000,
    );
    const ctx = RequestContextStore.get();

    await tx.refreshToken.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        // Only the hash is stored: a database read cannot yield a usable token.
        tokenHash: sha256(refreshToken),
        familyId: input.familyId ?? randomUUID(),
        parentId: input.parentId,
        expiresAt,
        ip: ctx?.ip,
        userAgent: ctx?.userAgent,
      },
    });

    return { accessToken, refreshToken, expiresIn: 15 * 60 };
  }

  /**
   * Accepts the adjacent time windows to tolerate clock drift on the user's
   * phone. One step either side is the usual balance between usability and
   * keeping the replay window small.
   */
  private verifyTotp(secret: string, code: string): boolean {
    const totp = new OTPAuth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
    return totp.validate({ token: code, window: 1 }) !== null;
  }

}
