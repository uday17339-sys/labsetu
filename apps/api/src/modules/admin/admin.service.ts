import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { hashPassword, randomEnrolmentCode } from '@labsetu/crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { RequestContextStore } from '../../common/context/request-context';

/**
 * User and competency administration.
 *
 * Two things a lab cannot run without and could not previously do:
 *
 *   1. Onboard a staff member. A new technician joining on Monday should not
 *      require a developer with database access.
 *   2. Record a competency assessment. Authorisation *requires* current
 *      competency (ISO 15189 §6.2, enforced in ResultsService), so without this
 *      a newly hired pathologist could never authorise anything at all. The
 *      control was real; the way to satisfy it was missing.
 *
 * Users are deactivated, never deleted — a signature must stay attributable to
 * a real person forever.
 */
/**
 * A temporary password that survives being read aloud across a reception desk.
 *
 * `randomEnrolmentCode` excludes 0/O/1/I/L, so "was that a one or an ell" never
 * happens. Four groups of four ≈ 79 bits — 20 characters, comfortably past the
 * 12-character policy floor, and it only has to live until first sign-in.
 */
function temporaryPassword(): string {
  return `Lab-${randomEnrolmentCode(4, 4)}`;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listUsers(q: { status?: string; search?: string; roleCode?: string }) {
    const users = await this.prisma.tx.user.findMany({
      where: {
        ...(q.status ? { status: q.status as never } : {}),
        ...(q.search
          ? {
              OR: [
                { fullName: { contains: q.search, mode: 'insensitive' } },
                { email: { contains: q.search.toLowerCase() } },
              ],
            }
          : {}),
        ...(q.roleCode ? { roles: { some: { role: { code: q.roleCode } } } } : {}),
      },
      orderBy: [{ status: 'asc' }, { fullName: 'asc' }],
      include: {
        roles: { include: { role: { select: { code: true, name: true } }, lab: { select: { code: true } } } },
        _count: { select: { competencies: true } },
      },
    });

    return users.map((u) => ({
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      qualification: u.qualification,
      registrationNo: u.registrationNo,
      phone: u.phone,
      status: u.status,
      isMfaEnabled: u.isMfaEnabled,
      mustChangePassword: u.mustChangePassword,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      lockedUntil: u.lockedUntil?.toISOString() ?? null,
      roles: u.roles.map((r) => ({
        code: r.role.code,
        name: r.role.name,
        lab: r.lab?.code ?? null,
      })),
      competencyCount: u._count.competencies,
    }));
  }

  async getUser(id: string) {
    const u = await this.prisma.tx.user.findUnique({
      where: { id },
      include: {
        roles: { include: { role: true, lab: { select: { id: true, code: true, name: true } } } },
        competencies: {
          orderBy: [{ revokedAt: 'asc' }, { validFrom: 'desc' }],
          include: { testDefinition: { select: { id: true, code: true, name: true, department: true } } },
        },
      },
    });
    if (!u) throw new NotFoundException('User not found');

    const now = new Date();
    return {
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      qualification: u.qualification,
      registrationNo: u.registrationNo,
      phone: u.phone,
      status: u.status,
      isMfaEnabled: u.isMfaEnabled,
      mustChangePassword: u.mustChangePassword,
      failedLoginCount: u.failedLoginCount,
      lockedUntil: u.lockedUntil?.toISOString() ?? null,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
      roles: u.roles.map((r) => ({
        id: r.id,
        roleId: r.roleId,
        code: r.role.code,
        name: r.role.name,
        permissionCount: r.role.permissions.length,
        lab: r.lab ? { id: r.lab.id, code: r.lab.code, name: r.lab.name } : null,
        grantedAt: r.grantedAt.toISOString(),
      })),
      competencies: u.competencies.map((c) => ({
        id: c.id,
        test: c.testDefinition,
        level: c.level,
        validFrom: c.validFrom.toISOString(),
        validUntil: c.validUntil?.toISOString() ?? null,
        evidenceNote: c.evidenceNote,
        revokedAt: c.revokedAt?.toISOString() ?? null,
        /// What the authorisation gate will actually see.
        isCurrent:
          !c.revokedAt && c.validFrom <= now && (!c.validUntil || c.validUntil >= now),
      })),
    };
  }

  /**
   * Creates a user with a temporary password that must be changed at first
   * login. The password is returned exactly once, in the response, so the
   * administrator can hand it over — it is never stored in plaintext, never
   * emailed by this endpoint, and never recoverable afterwards.
   */
  async createUser(input: {
    email: string;
    fullName: string;
    roleIds: string[];
    labId?: string;
    qualification?: string;
    registrationNo?: string;
    phone?: string;
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;
    const email = input.email.trim().toLowerCase();

    const existing = await tx.user.findFirst({ where: { email } });
    if (existing) {
      throw new BadRequestException(`A user with the email ${email} already exists`);
    }

    const roles = await tx.role.findMany({ where: { id: { in: input.roleIds } } });
    if (roles.length !== input.roleIds.length) {
      throw new BadRequestException('One or more roles do not exist in this tenant');
    }
    if (roles.length === 0) {
      throw new BadRequestException(
        'Assign at least one role. A user with no role can sign in but do nothing, ' +
          'which looks like a broken system rather than a permissions decision.',
      );
    }

    const tempPassword = temporaryPassword();

    const user = await tx.user.create({
      data: {
        tenantId: ctx.tenantId!,
        email,
        passwordHash: await hashPassword(tempPassword),
        fullName: input.fullName.trim(),
        qualification: input.qualification?.trim() || null,
        registrationNo: input.registrationNo?.trim() || null,
        phone: input.phone?.trim() || null,
        mustChangePassword: true,
        createdBy: ctx.userId,
        roles: {
          create: roles.map((r) => ({
            tenantId: ctx.tenantId!,
            roleId: r.id,
            labId: input.labId ?? null,
            grantedBy: ctx.userId,
          })),
        },
      },
    });

    await this.audit.record(tx, {
      action: 'CREATE',
      entityType: 'User',
      entityId: user.id,
      after: {
        email,
        fullName: user.fullName,
        roles: roles.map((r) => r.code),
        labId: input.labId ?? null,
        mustChangePassword: true,
      },
    });

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      temporaryPassword: tempPassword,
      note: 'Shown once. The user must change it at first sign-in.',
    };
  }

  async updateUser(
    id: string,
    input: {
      fullName?: string;
      qualification?: string | null;
      registrationNo?: string | null;
      phone?: string | null;
      status?: string;
    },
  ) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const before = await tx.user.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('User not found');

    // Locking yourself out of your own tenant is a support call nobody enjoys.
    if (id === ctx.userId && input.status && input.status !== 'ACTIVE') {
      throw new ForbiddenException(
        'You cannot deactivate your own account. Ask another administrator.',
      );
    }

    const data: Record<string, unknown> = {};
    if (input.fullName !== undefined) data.fullName = input.fullName.trim();
    if (input.qualification !== undefined) data.qualification = input.qualification || null;
    if (input.registrationNo !== undefined) data.registrationNo = input.registrationNo || null;
    if (input.phone !== undefined) data.phone = input.phone || null;
    if (input.status !== undefined) {
      data.status = input.status;
      // Deactivation must take effect now, not when the access token expires.
      if (input.status !== 'ACTIVE') data.tokenVersion = { increment: 1 };
      // Reactivating clears a lockout; otherwise the user is still stuck.
      if (input.status === 'ACTIVE') {
        data.lockedUntil = null;
        data.failedLoginCount = 0;
      }
    }

    const after = await tx.user.update({ where: { id }, data });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'User',
      entityId: id,
      before: {
        fullName: before.fullName,
        status: before.status,
        qualification: before.qualification,
        registrationNo: before.registrationNo,
      },
      after: {
        fullName: after.fullName,
        status: after.status,
        qualification: after.qualification,
        registrationNo: after.registrationNo,
      },
    });

    return { id, status: after.status, fullName: after.fullName };
  }

  /** Issues a new temporary password and invalidates every live session. */
  async resetPassword(id: string, reason: string) {
    const tx = this.prisma.tx;
    const user = await tx.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    const tempPassword = temporaryPassword();

    await tx.user.update({
      where: { id },
      data: {
        passwordHash: await hashPassword(tempPassword),
        mustChangePassword: true,
        passwordChangedAt: new Date(),
        tokenVersion: { increment: 1 },
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    // Outstanding refresh tokens must die with the password.
    await tx.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'User',
      entityId: id,
      reason,
      after: { event: 'PASSWORD_RESET_BY_ADMIN', email: user.email, sessionsRevoked: true },
    });

    return {
      id,
      email: user.email,
      temporaryPassword: tempPassword,
      note: 'Shown once. All existing sessions were signed out.',
    };
  }

  async setRoles(id: string, roleIds: string[], labId?: string) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const user = await tx.user.findUnique({
      where: { id },
      include: { roles: { include: { role: { select: { code: true } } } } },
    });
    if (!user) throw new NotFoundException('User not found');

    const roles = await tx.role.findMany({ where: { id: { in: roleIds } } });
    if (roles.length !== roleIds.length) {
      throw new BadRequestException('One or more roles do not exist in this tenant');
    }
    if (roles.length === 0) {
      throw new BadRequestException('A user must hold at least one role');
    }

    // Removing your own administrator role mid-session is the other easy way to
    // lock a tenant out of itself.
    if (id === ctx.userId) {
      const keepsAdmin = roles.some((r) => r.code === 'LAB_ADMIN');
      const hadAdmin = user.roles.some((r) => r.role.code === 'LAB_ADMIN');
      if (hadAdmin && !keepsAdmin) {
        throw new ForbiddenException(
          'You cannot remove your own administrator role. Ask another administrator.',
        );
      }
    }

    await tx.userRole.deleteMany({ where: { userId: id } });
    await tx.userRole.createMany({
      data: roles.map((r) => ({
        tenantId: ctx.tenantId!,
        userId: id,
        roleId: r.id,
        labId: labId ?? null,
        grantedBy: ctx.userId,
      })),
    });
    // Permissions are baked into the access token; force a re-issue.
    await tx.user.update({ where: { id }, data: { tokenVersion: { increment: 1 } } });

    await this.audit.record(tx, {
      action: 'UPDATE',
      entityType: 'User',
      entityId: id,
      before: { roles: user.roles.map((r) => r.role.code) },
      after: { roles: roles.map((r) => r.code), labId: labId ?? null },
    });

    return { id, roles: roles.map((r) => r.code) };
  }

  async listRoles() {
    const roles = await this.prisma.tx.role.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { userRoles: true } } },
    });
    return roles.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
      permissionCount: r.permissions.length,
      isSystem: r.isSystem,
      userCount: r._count.userRoles,
    }));
  }

  // --- competency -----------------------------------------------------------

  /**
   * Records a competency assessment.
   *
   * NABL 112 and ISO 15189 §6.2 require documented evidence that the person who
   * performed, verified or authorised a test was assessed as competent to do so.
   * `evidenceNote` is where that evidence is named — the assessment record, the
   * training date, the supervisor. It is mandatory for that reason.
   */
  async grantCompetency(input: {
    userId: string;
    testDefinitionIds: string[];
    level: 'PERFORM' | 'VERIFY' | 'AUTHORIZE';
    validFrom?: Date;
    validUntil?: Date;
    evidenceNote: string;
  }) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.status !== 'ACTIVE') {
      throw new BadRequestException(
        `${user.fullName} is ${user.status.toLowerCase()}. Reactivate the account before ` +
          `recording a competency assessment against it.`,
      );
    }

    const tests = await tx.testDefinition.findMany({
      where: { id: { in: input.testDefinitionIds } },
      select: { id: true, code: true, name: true },
    });
    if (tests.length !== input.testDefinitionIds.length) {
      throw new BadRequestException('One or more tests do not exist');
    }

    const validFrom = input.validFrom ?? new Date();
    if (input.validUntil && input.validUntil <= validFrom) {
      throw new BadRequestException('The expiry date must be after the start date');
    }

    const created: { id: string; test: string }[] = [];
    for (const test of tests) {
      // Re-assessment supersedes rather than duplicates: revoke the live record
      // for the same user/test/level, then write the new one. Otherwise the
      // competency list becomes an unreadable pile after a few annual reviews.
      await tx.userCompetency.updateMany({
        where: {
          userId: input.userId,
          testDefinitionId: test.id,
          level: input.level,
          revokedAt: null,
        },
        data: { revokedAt: new Date(), revokedBy: ctx.userId },
      });

      const rec = await tx.userCompetency.create({
        data: {
          tenantId: ctx.tenantId!,
          userId: input.userId,
          testDefinitionId: test.id,
          level: input.level,
          validFrom,
          validUntil: input.validUntil ?? null,
          grantedBy: ctx.userId!,
          evidenceNote: input.evidenceNote,
        },
      });
      created.push({ id: rec.id, test: test.code });

      await this.audit.record(tx, {
        action: 'CREATE',
        entityType: 'UserCompetency',
        entityId: rec.id,
        after: {
          user: user.fullName,
          userId: input.userId,
          test: test.code,
          level: input.level,
          validFrom: validFrom.toISOString(),
          validUntil: input.validUntil?.toISOString() ?? null,
          evidenceNote: input.evidenceNote,
        },
      });
    }

    return {
      userId: input.userId,
      userName: user.fullName,
      level: input.level,
      granted: created,
      count: created.length,
    };
  }

  async revokeCompetency(competencyId: string, reason: string) {
    const ctx = RequestContextStore.require();
    const tx = this.prisma.tx;

    const rec = await tx.userCompetency.findUnique({
      where: { id: competencyId },
      include: {
        testDefinition: { select: { code: true } },
        user: { select: { fullName: true } },
      },
    });
    if (!rec) throw new NotFoundException('Competency record not found');
    if (rec.revokedAt) throw new BadRequestException('This competency is already revoked');

    await tx.userCompetency.update({
      where: { id: competencyId },
      data: { revokedAt: new Date(), revokedBy: ctx.userId },
    });

    await this.audit.record(tx, {
      action: 'DELETE',
      entityType: 'UserCompetency',
      entityId: competencyId,
      reason,
      before: {
        user: rec.user.fullName,
        test: rec.testDefinition.code,
        level: rec.level,
      },
      after: { revoked: true },
    });

    return { id: competencyId, revoked: true };
  }

  /**
   * The competency matrix: who may do what, and what is about to lapse.
   *
   * An assessor asks for exactly this, and a lab manager needs the expiry
   * warning before a pathologist is silently unable to authorise on a Monday
   * morning.
   */
  async competencyMatrix() {
    const tx = this.prisma.tx;
    const now = new Date();
    const soon = new Date(Date.now() + 30 * 864e5);

    const records = await tx.userCompetency.findMany({
      where: { revokedAt: null },
      include: {
        user: { select: { id: true, fullName: true, status: true } },
        testDefinition: { select: { id: true, code: true, name: true, department: true } },
      },
      orderBy: { validFrom: 'desc' },
    });

    const live = records.filter(
      (r) => r.validFrom <= now && (!r.validUntil || r.validUntil >= now),
    );
    const expiring = live.filter((r) => r.validUntil && r.validUntil <= soon);
    const expired = records.filter((r) => r.validUntil && r.validUntil < now);

    const byUser = new Map<string, { name: string; status: string; entries: unknown[] }>();
    for (const r of live) {
      const row = byUser.get(r.user.id) ?? {
        name: r.user.fullName,
        status: r.user.status,
        entries: [],
      };
      row.entries.push({
        competencyId: r.id,
        test: r.testDefinition.code,
        testName: r.testDefinition.name,
        department: r.testDefinition.department,
        level: r.level,
        validUntil: r.validUntil?.toISOString() ?? null,
      });
      byUser.set(r.user.id, row);
    }

    return {
      users: [...byUser.entries()].map(([userId, v]) => ({ userId, ...v })),
      expiringWithin30Days: expiring.map((r) => ({
        competencyId: r.id,
        user: r.user.fullName,
        test: r.testDefinition.code,
        level: r.level,
        validUntil: r.validUntil!.toISOString(),
      })),
      expired: expired.map((r) => ({
        competencyId: r.id,
        user: r.user.fullName,
        test: r.testDefinition.code,
        level: r.level,
        validUntil: r.validUntil!.toISOString(),
      })),
      counts: { live: live.length, expiring: expiring.length, expired: expired.length },
    };
  }
}
