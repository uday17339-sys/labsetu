import { SetMetadata, applyDecorators } from '@nestjs/common';
import type { Permission } from '@labsetu/contracts';

export const PERMISSIONS_KEY = 'labsetu:permissions';
export const PUBLIC_KEY = 'labsetu:public';
export const DEVICE_AUTH_KEY = 'labsetu:device-auth';

/**
 * Declares what a route requires. The guard denies anything not declared —
 * deny-by-default is the only posture that survives a growing codebase, because
 * the failure mode of forgetting a decorator becomes "route is inaccessible"
 * rather than "route is open to everyone".
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Explicitly unauthenticated. Deliberately verbose to type and easy to grep —
 * every use of it should be individually justifiable.
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Authenticated by device credentials (the on-prem gateway), not a user JWT. */
export const DeviceAuth = () =>
  applyDecorators(SetMetadata(DEVICE_AUTH_KEY, true), SetMetadata(PUBLIC_KEY, true));
