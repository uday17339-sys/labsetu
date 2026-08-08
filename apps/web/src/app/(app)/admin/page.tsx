import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { apiFetch, ApiError } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, EmptyState, Stat, StatusPill } from '@/components/ui';
import { dateTime } from '@/lib/format';
import { CreateUserForm } from './forms';

export const dynamic = 'force-dynamic';

interface UserRow {
  id: string;
  email: string;
  fullName: string;
  qualification: string | null;
  status: string;
  isMfaEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  roles: { code: string; name: string; lab: string | null }[];
  competencyCount: number;
}

interface Role {
  id: string;
  code: string;
  name: string;
  description: string | null;
  permissions: string[];
  permissionCount: number;
  isSystem: boolean;
  userCount: number;
}

interface Matrix {
  users: { userId: string; name: string; status: string; entries: unknown[] }[];
  expiringWithin30Days: {
    competencyId: string;
    user: string;
    test: string;
    level: string;
    validUntil: string;
  }[];
  expired: {
    competencyId: string;
    user: string;
    test: string;
    level: string;
    validUntil: string;
  }[];
  counts: { live: number; expiring: number; expired: number };
}

/**
 * A temporary password is returned exactly once and is never recoverable. It is
 * parked in a short-lived, httpOnly cookie so it survives the redirect that
 * follows the server action, then cleared as soon as it has been shown. Putting
 * it in the URL would leave it in browser history and server logs.
 */
const HANDOFF_COOKIE = 'labsetu_temp_credential';

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string }>;
}) {
  const sp = await searchParams;
  const user = await getSessionUser();

  const qs = new URLSearchParams();
  if (sp.status) qs.set('status', sp.status);
  if (sp.search) qs.set('search', sp.search);

  const [users, roles, matrix, refData] = await Promise.all([
    apiFetch<UserRow[]>(`/admin/users?${qs.toString()}`).catch(() => []),
    apiFetch<Role[]>('/admin/roles').catch(() => []),
    apiFetch<Matrix>('/admin/competency').catch(() => null),
    apiFetch<{ labs: { id: string; code: string; name: string }[] }>(
      '/catalog/reference-data',
    ).catch(() => ({ labs: [] })),
  ]);

  const store = await cookies();
  const handoff = store.get(HANDOFF_COOKIE)?.value;

  async function createUser(formData: FormData): Promise<void> {
    'use server';
    const result = await apiFetch<{ email: string; fullName: string; temporaryPassword: string }>(
      '/admin/users',
      {
        method: 'POST',
        body: {
          email: String(formData.get('email') ?? '').trim(),
          fullName: String(formData.get('fullName') ?? '').trim(),
          roleIds: [String(formData.get('roleId') ?? '')],
          labId: String(formData.get('labId') ?? '') || undefined,
          phone: String(formData.get('phone') ?? '').trim() || undefined,
          qualification: String(formData.get('qualification') ?? '').trim() || undefined,
          registrationNo: String(formData.get('registrationNo') ?? '').trim() || undefined,
        },
      },
    );

    const jar = await cookies();
    jar.set(HANDOFF_COOKIE, `${result.fullName}|${result.email}|${result.temporaryPassword}`, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/admin',
      maxAge: 120,
    });
    revalidatePath('/admin');
  }

  async function dismissHandoff(): Promise<void> {
    'use server';
    (await cookies()).delete({ name: HANDOFF_COOKIE, path: '/admin' });
    revalidatePath('/admin');
  }

  const canManage = can(user, 'user:manage');
  const active = users.filter((u) => u.status === 'ACTIVE').length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink-900">Staff &amp; competency</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Who works here, what they may do, and what they are assessed as competent to perform.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/catalog"
            className="min-h-11 rounded-md border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-100"
          >
            Test catalog
          </Link>
        </div>
      </div>

      {handoff && <CredentialHandoff value={handoff} dismiss={dismissHandoff} />}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Active staff" value={active} />
        <Stat label="Live competencies" value={matrix?.counts.live ?? 0} />
        <Stat
          label="Expiring in 30 days"
          value={matrix?.counts.expiring ?? 0}
          tone={(matrix?.counts.expiring ?? 0) > 0 ? 'warn' : 'default'}
        />
        <Stat
          label="Expired"
          value={matrix?.counts.expired ?? 0}
          tone={(matrix?.counts.expired ?? 0) > 0 ? 'critical' : 'default'}
        />
      </div>

      {/* An expired AUTHORIZE competency means a pathologist silently cannot
          sign off. That is a Monday-morning outage nobody diagnoses quickly. */}
      {matrix && matrix.expired.length > 0 && (
        <div className="rounded-lg border-2 border-[var(--color-critical)] bg-[var(--color-critical-bg)] px-4 py-3">
          <p className="text-sm font-bold text-[var(--color-critical)]">
            {matrix.expired.length} competenc
            {matrix.expired.length > 1 ? 'ies have' : 'y has'} lapsed
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-critical)] opacity-90">
            The system will refuse these actions until the assessment is renewed.
          </p>
          <ul className="mt-2 space-y-1 text-xs text-[var(--color-critical)]">
            {matrix.expired.slice(0, 8).map((e) => (
              <li key={e.competencyId}>
                <span className="font-medium">{e.user}</span> — {e.test} ·{' '}
                {e.level.toLowerCase()} · lapsed{' '}
                {new Date(e.validUntil).toLocaleDateString('en-IN')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {matrix && matrix.expiringWithin30Days.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900">
            {matrix.expiringWithin30Days.length} competenc
            {matrix.expiringWithin30Days.length > 1 ? 'ies expire' : 'y expires'} within 30 days
          </p>
          <ul className="mt-1.5 space-y-0.5 text-xs text-amber-800">
            {matrix.expiringWithin30Days.slice(0, 8).map((e) => (
              <li key={e.competencyId}>
                {e.user} — {e.test} · {e.level.toLowerCase()} · until{' '}
                {new Date(e.validUntil).toLocaleDateString('en-IN')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {canManage && roles.length > 0 && (
          <Card title="Add a staff member">
            <CreateUserForm action={createUser} roles={roles} labs={refData.labs} />
          </Card>
        )}

        <Card className={canManage && roles.length > 0 ? 'lg:col-span-2' : 'lg:col-span-3'} title="Staff">
          <form className="flex flex-wrap items-end gap-2 border-b border-ink-100 px-4 py-3">
            <label className="min-w-0 flex-1 sm:max-w-xs">
              <span className="mb-1 block text-xs font-medium text-ink-600">Search</span>
              <input
                name="search"
                defaultValue={sp.search ?? ''}
                placeholder="Name or email"
                className="h-11 w-full rounded-md border border-ink-300 px-2 text-base sm:text-sm"
              />
            </label>
            <label>
              <span className="mb-1 block text-xs font-medium text-ink-600">Status</span>
              <select
                name="status"
                defaultValue={sp.status ?? ''}
                className="h-11 rounded-md border border-ink-300 bg-white px-2 text-base sm:text-sm"
              >
                <option value="">All</option>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
                <option value="LOCKED">Locked</option>
              </select>
            </label>
            <button
              type="submit"
              className="min-h-11 rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
            >
              Apply
            </button>
          </form>

          {users.length === 0 ? (
            <EmptyState title="No staff match" />
          ) : (
            <ul className="divide-y divide-ink-100">
              {users.map((u) => (
                <li key={u.id}>
                  <Link
                    href={`/admin/users/${u.id}`}
                    className="flex items-start justify-between gap-3 px-4 py-3 active:bg-ink-50 hover:bg-ink-50"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-ink-900">
                        {u.fullName}
                        {u.qualification && (
                          <span className="ml-1 font-normal text-ink-500">{u.qualification}</span>
                        )}
                      </div>
                      <div className="truncate text-xs text-ink-500">{u.email}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {u.roles.map((r) => (
                          <span
                            key={r.code}
                            className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-600"
                          >
                            {r.name}
                            {r.lab && ` · ${r.lab}`}
                          </span>
                        ))}
                        {u.competencyCount > 0 && (
                          <span className="text-[10px] text-ink-400">
                            {u.competencyCount} competenc{u.competencyCount > 1 ? 'ies' : 'y'}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <StatusPill status={u.status} />
                      <div className="numeric mt-1 text-[10px] text-ink-400">
                        {u.lastLoginAt ? dateTime(u.lastLoginAt) : 'never signed in'}
                      </div>
                      {u.mustChangePassword && (
                        <div className="mt-0.5 text-[10px] font-medium text-amber-700">
                          password change pending
                        </div>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Roles">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2 font-medium">Role</th>
                <th className="px-4 py-2 font-medium">Description</th>
                <th className="px-4 py-2 text-right font-medium">Permissions</th>
                <th className="px-4 py-2 text-right font-medium">Staff</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {roles.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2 font-medium text-ink-900">{r.name}</td>
                  <td className="px-4 py-2 text-xs text-ink-500">{r.description ?? '—'}</td>
                  <td className="numeric px-4 py-2 text-right text-ink-600">
                    {r.permissionCount}
                  </td>
                  <td className="numeric px-4 py-2 text-right text-ink-600">{r.userCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function CredentialHandoff({
  value,
  dismiss,
}: {
  value: string;
  dismiss: () => Promise<void>;
}) {
  const [name, email, password] = value.split('|');

  return (
    <div className="rounded-lg border-2 border-brand-600 bg-brand-50 px-4 py-3">
      <p className="text-sm font-bold text-brand-700">
        {name} created — hand these over now
      </p>
      <p className="mt-0.5 text-xs text-brand-700 opacity-90">
        The password is shown once and cannot be recovered. If it is lost, reset it from the
        user&rsquo;s page.
      </p>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="rounded border border-brand-200 bg-white px-3 py-2">
          <dt className="text-[10px] uppercase tracking-wide text-ink-500">Sign in with</dt>
          <dd className="numeric break-all text-sm font-medium text-ink-900">{email}</dd>
        </div>
        <div className="rounded border border-brand-200 bg-white px-3 py-2">
          <dt className="text-[10px] uppercase tracking-wide text-ink-500">
            Temporary password
          </dt>
          <dd className="numeric break-all text-base font-bold tracking-wide text-ink-900">
            {password}
          </dd>
        </div>
      </dl>
      <form action={dismiss} className="mt-2">
        <button
          type="submit"
          className="min-h-11 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          I have noted it — dismiss
        </button>
      </form>
    </div>
  );
}
