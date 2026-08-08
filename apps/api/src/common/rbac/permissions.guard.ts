import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@labsetu/contracts';
import { PERMISSIONS_KEY, PUBLIC_KEY, DEVICE_AUTH_KEY } from './permissions.decorator';
import { RequestContextStore } from '../context/request-context';

/**
 * Enforces declared permissions, and refuses routes that declare none.
 *
 * That second behaviour is the point. A route with no @RequirePermissions and no
 * @Public is a developer oversight, and the safe interpretation of an oversight
 * in software holding patient data is "closed".
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(DEVICE_AUTH_KEY, targets)) return true;

    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, targets);
    const ctx = RequestContextStore.get();

    if (!required || required.length === 0) {
      this.logger.error(
        `Route ${ctx?.method} ${ctx?.path} declares no permissions and is not @Public(). ` +
          `Denying by default — add @RequirePermissions(...) or @Public().`,
      );
      throw new ForbiddenException('This route is not accessible');
    }

    if (!ctx?.userId) throw new ForbiddenException('Not authenticated');

    const missing = required.filter((p) => !ctx.permissions.has(p));
    if (missing.length > 0) {
      // Logged at warn, not error: a denied permission is usually a
      // misconfigured role, not an attack. Spikes are alerted on separately.
      this.logger.warn(
        `Permission denied: user=${ctx.userId} route=${ctx.method} ${ctx.path} missing=[${missing.join(', ')}]`,
      );
      throw new ForbiddenException(
        `You do not have permission to do this (requires: ${missing.join(', ')})`,
      );
    }

    return true;
  }
}
