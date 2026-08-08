import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestContextStore } from '../context/request-context';

export interface CurrentUserInfo {
  id: string;
  tenantId: string;
  display: string;
  role: string;
  permissions: Set<string>;
}

/**
 * Reads the authenticated actor from the request context rather than from the
 * request object, so the same accessor works in services and background code
 * paths that never see an Express request.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext): CurrentUserInfo => {
    const ctx = RequestContextStore.require();
    if (!ctx.userId || !ctx.tenantId) {
      throw new Error('@CurrentUser used on a route that is not authenticated');
    }
    return {
      id: ctx.userId,
      tenantId: ctx.tenantId,
      display: ctx.userDisplay ?? '',
      role: ctx.userRole ?? '',
      permissions: ctx.permissions,
    };
  },
);
