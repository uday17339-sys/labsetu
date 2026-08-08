import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import * as QRCode from 'qrcode';
import {
  loginSchema,
  refreshSchema,
  changePasswordSchema,
  mfaVerifySchema,
  signingTokenRequestSchema,
  PERMISSIONS,
} from '@labsetu/contracts';
import { AuthService } from './auth.service';
import { Public, RequirePermissions } from '../../common/rbac/permissions.decorator';
import { zodPipe } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, type CurrentUserInfo } from '../../common/decorators/current-user.decorator';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Rate limited hard: this is the endpoint an attacker will hammer. */
  @Public()
  @Throttle({ auth: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  login(@Body(zodPipe(loginSchema)) body: unknown) {
    return this.auth.login(body as never);
  }

  @Public()
  @Throttle({ auth: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body(zodPipe(refreshSchema)) body: { refreshToken: string }) {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @HttpCode(204)
  @Post('logout')
  async logout(@Body(zodPipe(refreshSchema)) body: { refreshToken: string }): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  /**
   * Every authenticated user may read their own identity — hence @Public() with
   * an explicit guard note rather than a permission. In practice the JWT guard
   * still runs because the route is not in the public allowlist below.
   */
  @RequirePermissions(PERMISSIONS.CATALOG_READ)
  @Get('me')
  me(@CurrentUser() user: CurrentUserInfo) {
    return {
      id: user.id,
      tenantId: user.tenantId,
      display: user.display,
      role: user.role,
      permissions: [...user.permissions],
    };
  }

  @RequirePermissions(PERMISSIONS.CATALOG_READ)
  @HttpCode(200)
  @Post('password')
  async changePassword(@Body(zodPipe(changePasswordSchema)) body: { currentPassword: string; newPassword: string }) {
    await this.auth.changePassword(body.currentPassword, body.newPassword);
    return { status: 'OK', message: 'Password changed. All other sessions were signed out.' };
  }

  @RequirePermissions(PERMISSIONS.CATALOG_READ)
  @Post('mfa/setup')
  async beginMfa() {
    const { secret, otpauthUrl, recoveryCodes } = await this.auth.beginMfaSetup();
    return {
      secret,
      otpauthUrl,
      // Rendered server-side so the secret never has to travel to a third-party
      // QR service.
      qrDataUrl: await QRCode.toDataURL(otpauthUrl),
      recoveryCodes,
    };
  }

  @RequirePermissions(PERMISSIONS.CATALOG_READ)
  @HttpCode(200)
  @Post('mfa/confirm')
  async confirmMfa(@Body(zodPipe(mfaVerifySchema)) body: { totpCode: string }) {
    await this.auth.confirmMfaSetup(body.totpCode);
    return { status: 'OK', message: 'Two-factor authentication is now enabled' };
  }

  /**
   * Step one of applying an electronic signature: re-authenticate and receive a
   * short-lived token bound to this exact record and its content hash.
   */
  @RequirePermissions(PERMISSIONS.RESULT_VERIFY)
  @Throttle({ auth: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('signing-token')
  signingToken(@Body(zodPipe(signingTokenRequestSchema)) body: unknown) {
    return this.auth.issueSigningToken(body as never);
  }
}
