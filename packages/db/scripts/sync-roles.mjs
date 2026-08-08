#!/usr/bin/env node
/**
 * Reconciles seeded SYSTEM roles with the current DEFAULT_ROLES definition.
 *
 * Why this exists: role rows are written once at seed time. Adding a permission
 * to the registry later therefore has no effect on a running deployment — the
 * endpoint exists, the role does not grant it, and every request 403s. That is
 * a genuinely confusing failure, because the code looks correct.
 *
 * Run this after any deploy that adds permissions:
 *     npm run db:sync-roles
 *
 * Only touches roles marked isSystem. Custom roles a lab has created are left
 * alone — silently rewriting a customer's own role definitions would be worse
 * than the problem this solves.
 */
import { PrismaClient } from '@prisma/client';
import { DEFAULT_ROLES } from '@labsetu/contracts';

const prisma = new PrismaClient();

try {
  // The tenant table is behind RLS, so a plain SELECT returns zero rows without
  // a tenant context — correct, and exactly why this uses the narrow
  // SECURITY DEFINER listing function (security.sql §3b). Each tenant's roles
  // are then updated inside its own context; there is no cross-tenant write.
  const tenants = await prisma.$queryRaw`SELECT * FROM labsetu_list_tenants()`;

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const tenant of tenants) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;

      const roles = await tx.role.findMany({ where: { isSystem: true } });
      const existing = new Set(roles.map((r) => r.code));

      // A role ADDED to the registry after a tenant was seeded would otherwise
      // never reach it — the loop below only reconciles roles that already
      // exist. That is how the manufacturing roles (STORES, QC_ANALYST, QA)
      // were invisible on a running deployment despite being defined.
      for (const [code, target] of Object.entries(DEFAULT_ROLES)) {
        if (existing.has(code)) continue;
        await tx.role.create({
          data: {
            tenantId: tenant.id,
            code,
            name: target.name,
            description: target.description,
            permissions: [...new Set(target.permissions)].sort(),
            isSystem: true,
          },
        });
        created++;
        console.log(`  ${tenant.code}/${code}  [32mcreated[0m  ${target.permissions.length} permissions`);
      }

      for (const role of roles) {
        const target = DEFAULT_ROLES[role.code];
        if (!target) continue;

        const current = [...role.permissions].sort();
        const desired = [...new Set(target.permissions)].sort();

        const added = desired.filter((p) => !current.includes(p));
        const removed = current.filter((p) => !desired.includes(p));

        if (added.length === 0 && removed.length === 0) {
          unchanged++;
          continue;
        }

        await tx.role.update({
          where: { id: role.id },
          data: { permissions: desired, name: target.name, description: target.description },
        });

        updated++;
        console.log(`  ${tenant.code}/${role.code}`);
        if (added.length) console.log(`    + ${added.join(', ')}`);
        if (removed.length) console.log(`    - ${removed.join(', ')}`);
      }
    });
  }

  console.log(
    `\n  ${updated} role(s) updated, ${unchanged} already current, across ${tenants.length} tenant(s).`,
  );
  if (updated > 0) {
    // Permissions live in the access token, so a user carries the old set until
    // their 15-minute token rotates.
    console.log('  Users pick up new permissions when their access token next refreshes.\n');
  }
} catch (err) {
  console.error('\n  Role sync failed:\n');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
