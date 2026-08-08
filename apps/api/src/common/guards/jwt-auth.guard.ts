import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { PUBLIC_KEY } from '../rbac/permissions.decorator';
import { RequestContextStore } from '../context/request-context';
import { PrismaService } from '../prisma/prisma.service';

export interface AccessTokenClaims {
  sub: string;
  tid: string;
  /** Bumped on password/role change or revocation — invalidates live tokens. */
  tv: number;
  name: string;
  role: string;
  perms: string[];
  labs: string[];
}

/**
 * Verifies the access token and populates the request context.
 *
 * Beyond signature validation it re-checks `tokenVersion` against the database
 * on every request. That costs one indexed lookup and closes the window where a
 * revoked or role-changed user keeps working until their 15-minute token
 * expires — in a system where roles gate who may authorise a clinical result,
 * that window is not acceptable.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = extractBearer(req);
    if (!token) throw new UnauthorizedException('Missing bearer token');

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token);
    } catch {
      // Deliberately uniform: distinguishing "expired" from "malformed" from
      // "wrong signature" tells an attacker which of their guesses was closer.
      throw new UnauthorizedException('Invalid or expired token');
    }

    const user = await this.prisma.withTenant(claims.tid, async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; tokenVersion: number; status: string; lockedUntil: Date | null }[]
      >`
        SELECT id, "tokenVersion", status::text, "lockedUntil"
        FROM "user" WHERE id = ${claims.sub}::uuid
      `;
      return rows[0];
    });

    if (!user) throw new UnauthorizedException('Invalid or expired token');
    if (user.status !== 'ACTIVE') throw new UnauthorizedException('Account is not active');
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException('Account is temporarily locked');
    }
    if (user.tokenVersion !== claims.tv) {
      throw new UnauthorizedException('Session is no longer valid — please sign in again');
    }

    const ctx = RequestContextStore.require();
    ctx.tenantId = claims.tid;
    ctx.userId = claims.sub;
    ctx.userDisplay = claims.name;
    ctx.userRole = claims.role;
    ctx.permissions = new Set(claims.perms);

    return true;
  }
}

function extractBearer(req: Request): string | undefined {
  const header = req.header('authorization');
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}
