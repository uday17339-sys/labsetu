import Link from 'next/link';
import { notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { apiFetch, ApiError } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, EmptyState, StatusPill } from '@/components/ui';
import { date, dateTime } from '@/lib/format';
import {
  GrantCompetencyForm,
  RevokeCompetencyForm,
  ResetPasswordForm,
  SetStatusForm,
} from '../../forms';

export const dynamic = 'force-dynamic';

const HANDOFF_COOKIE = 'labsetu_temp_credential';

interface Competency {
  id: string;
  test: { id: string; code: string; name: string; department: string };
  level: string;
  validFrom: string;
  validUntil: string | null;
  evidenceNote: string | null;
  revokedAt: string | null;
  isCurrent: boolean;
}

interface UserDetail {
  id: string;
  email: string;
  fullName: string;
  qualification: string | null;
  registrationNo: string | null;
  phone: string | null;
  status: string;
  isMfaEnabled: boolean;
  mustChangePassword: boolean;
  failedLoginCount: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  roles: {
    id: string;
    code: string;
    name: string;
    permissionCount: number;
    lab: { code: string; name: string } | null;
  }[];
  competencies: Competency[];
}

interface TestDef {
  id: string;
  code: string;
  name: string;
  department: string;
}

const LEVEL_ORDER = ['AUTHORIZE', 'VERIFY', 'PERFORM'];

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getSessionUser();

  const [detail, tests] = await Promise.all([
    apiFetch<UserDetail>(`/admin/users/${id}`).catch((e) => {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }),
    apiFetch<TestDef[]>('/catalog/tests').catch(() => [] as TestDef[]),
  ]);
  if (!detail) notFound();

  async function grantCompetency(formData: FormData): Promise<void> {
    'use server';
    const validFrom = String(formData.get('validFrom') ?? '').trim();
    const validUntil = String(formData.get('validUntil') ?? '').trim();
    await apiFetch('/admin/competency', {
      method: 'POST',
      body: {
        userId: id,
        testDefinitionIds: formData.getAll('testDefinitionIds').map(String),
        level: String(formData.get('level') ?? 'PERFORM'),
        validFrom: validFrom || undefined,
        validUntil: validUntil || undefined,
        evidenceNote: String(formData.get('evidenceNote') ?? '').trim(),
      },
    });
    revalidatePath(`/admin/users/${id}`);
    revalidatePath('/admin');
  }

  async function revokeCompetency(competencyId: string, formData: FormData): Promise<void> {
    'use server';
    await apiFetch(`/admin/competency/${competencyId}/revoke`, {
      method: 'POST',
      body: { reason: String(formData.get('reason') ?? '').trim() },
    });
    revalidatePath(`/admin/users/${id}`);
    revalidatePath('/admin');
  }

  async function resetPassword(formData: FormData): Promise<void> {
    'use server';
    const result = await apiFetch<{ email: string; temporaryPassword: string }>(
      `/admin/users/${id}/reset-password`,
      { method: 'POST', body: { reason: String(formData.get('reason') ?? '').trim() } },
    );
    const jar = await cookies();
    jar.set(
      HANDOFF_COOKIE,
      `Password reset|${result.email}|${result.temporaryPassword}`,
      { httpOnly: true, sameSite: 'lax', path: '/admin', maxAge: 120 },
    );
    revalidatePath(`/admin/users/${id}`);
  }

  async function setStatus(formData: FormData): Promise<void> {
    'use server';
    await apiFetch(`/admin/users/${id}`, {
      method: 'PATCH',
      body: { status: String(formData.get('status') ?? 'ACTIVE') },
    });
    revalidatePath(`/admin/users/${id}`);
    revalidatePath('/admin');
  }

  const store = await cookies();
  const handoff = store.get(HANDOFF_COOKIE)?.value;

  const canManage = can(me, 'user:manage');
  const canCompetency = can(me, 'competency:manage');
  const isSelf = me?.id === detail.id;

  const live = detail.competencies.filter((c) => c.isCurrent);
  const lapsed = detail.competencies.filter((c) => !c.isCurrent && !c.revokedAt);
  const revoked = detail.competencies.filter((c) => c.revokedAt);

  const canAuthorize = live.some((c) => c.level === 'AUTHORIZE');
  const holdsAuthorizeRole = detail.roles.some((r) =>
    ['QA', 'LAB_ADMIN', 'PATHOLOGIST'].includes(r.code),
  );

  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin" className="-ml-2 inline-flex min-h-11 items-center px-2 text-sm text-brand-600 hover:underline">
          ← Staff
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-words text-xl font-semibold text-ink-900">{detail.fullName}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-500">
              <StatusPill status={detail.status} />
              <span className="break-all">{detail.email}</span>
              {detail.qualification && <span>· {detail.qualification}</span>}
              {detail.registrationNo && (
                <span className="numeric">· {detail.registrationNo}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {handoff && <HandoffBanner value={handoff} />}

      {/* The sharpest failure mode in the whole system: someone who is supposed
          to sign reports but holds no AUTHORIZE competency. They will hit a
          refusal at the moment they try to release, which looks like a bug. */}
      {holdsAuthorizeRole && !canAuthorize && (
        <div className="rounded-lg border-2 border-[var(--color-critical)] bg-[var(--color-critical-bg)] px-4 py-3">
          <p className="text-sm font-bold text-[var(--color-critical)]">
            Cannot authorise any report
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-critical)] opacity-90">
            {detail.fullName} holds a role that permits authorisation, but no current AUTHORIZE
            competency for any test. ISO 15189 §6.2 requires documented competence, and the
            system enforces it — every attempt to release will be refused until an assessment is
            recorded below.
          </p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title={`Current competencies (${live.length})`}>
            {live.length === 0 ? (
              <EmptyState
                title="No competencies recorded"
                hint="This person cannot enter, verify or authorise any result."
              />
            ) : (
              <ul className="divide-y divide-ink-100">
                {live
                  .slice()
                  .sort(
                    (a, b) =>
                      LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) ||
                      a.test.code.localeCompare(b.test.code),
                  )
                  .map((c) => (
                    <li key={c.id} className="px-4 py-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <LevelBadge level={c.level} />
                            <span className="numeric text-xs text-ink-500">{c.test.code}</span>
                            <span className="truncate text-sm text-ink-900">{c.test.name}</span>
                          </div>
                          {c.evidenceNote && (
                            <p className="mt-0.5 text-xs text-ink-500">{c.evidenceNote}</p>
                          )}
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="numeric text-xs text-ink-500">
                            {c.validUntil ? `until ${date(c.validUntil)}` : 'no expiry'}
                          </div>
                          {canCompetency && (
                            <RevokeCompetencyForm action={revokeCompetency.bind(null, c.id)} />
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
              </ul>
            )}
          </Card>

          {lapsed.length > 0 && (
            <Card title={`Lapsed (${lapsed.length})`}>
              <ul className="divide-y divide-ink-100">
                {lapsed.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <LevelBadge level={c.level} muted />
                      <span className="numeric text-xs text-ink-500">{c.test.code}</span>
                      <span className="truncate text-ink-600">{c.test.name}</span>
                    </span>
                    <span className="numeric shrink-0 text-xs text-[var(--color-critical)]">
                      expired {date(c.validUntil)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {revoked.length > 0 && (
            <Card title={`Revoked (${revoked.length})`}>
              <ul className="divide-y divide-ink-100">
                {revoked.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 px-4 py-2 text-sm text-ink-400"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <LevelBadge level={c.level} muted />
                      <span className="numeric text-xs">{c.test.code}</span>
                      <span className="truncate line-through">{c.test.name}</span>
                    </span>
                    <span className="numeric shrink-0 text-xs">
                      revoked {date(c.revokedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card title="Account">
            <dl className="divide-y divide-ink-100 text-sm">
              <Row label="Roles">
                {detail.roles.map((r) => (
                  <span key={r.id} className="block">
                    {r.name}
                    {r.lab && <span className="text-ink-500"> · {r.lab.name}</span>}
                    <span className="numeric ml-1 text-xs text-ink-400">
                      ({r.permissionCount} permissions)
                    </span>
                  </span>
                ))}
              </Row>
              <Row label="Phone">{detail.phone ?? '—'}</Row>
              <Row label="Two-factor">{detail.isMfaEnabled ? 'Enabled' : 'Not enabled'}</Row>
              <Row label="Last sign-in">{dateTime(detail.lastLoginAt)}</Row>
              <Row label="Created">{date(detail.createdAt)}</Row>
              {detail.failedLoginCount > 0 && (
                <Row label="Failed sign-ins">
                  <span className="text-[var(--color-high)]">{detail.failedLoginCount}</span>
                </Row>
              )}
              {detail.lockedUntil && (
                <Row label="Locked until">
                  <span className="text-[var(--color-critical)]">
                    {dateTime(detail.lockedUntil)}
                  </span>
                </Row>
              )}
              {detail.mustChangePassword && (
                <Row label="Password">
                  <span className="text-amber-700">Must change at next sign-in</span>
                </Row>
              )}
            </dl>
          </Card>

          {canCompetency && tests.length > 0 && (
            <Card title="Record a competency assessment">
              <GrantCompetencyForm action={grantCompetency} tests={tests} />
            </Card>
          )}

          {canManage && !isSelf && (
            <>
              <Card title="Reset password">
                <ResetPasswordForm action={resetPassword} />
              </Card>
              <Card title={detail.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}>
                <SetStatusForm action={setStatus} current={detail.status} />
              </Card>
            </>
          )}

          {canManage && isSelf && (
            <p className="text-xs text-ink-400">
              You cannot reset or deactivate your own account — that is how a tenant locks itself
              out. Ask another administrator.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function LevelBadge({ level, muted }: { level: string; muted?: boolean }) {
  const styles: Record<string, string> = {
    AUTHORIZE: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    VERIFY: 'bg-violet-50 text-violet-700 ring-violet-200',
    PERFORM: 'bg-blue-50 text-blue-700 ring-blue-200',
  };
  return (
    <span
      className={`inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${
        muted ? 'bg-ink-100 text-ink-400 ring-ink-200' : (styles[level] ?? styles.PERFORM)
      }`}
    >
      {level.toLowerCase()}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 px-4 py-2">
      <dt className="shrink-0 text-ink-500">{label}</dt>
      <dd className="min-w-0 text-right text-ink-900">{children}</dd>
    </div>
  );
}

function HandoffBanner({ value }: { value: string }) {
  const [, email, password] = value.split('|');
  return (
    <div className="rounded-lg border-2 border-brand-600 bg-brand-50 px-4 py-3">
      <p className="text-sm font-bold text-brand-700">New temporary password</p>
      <p className="mt-0.5 text-xs text-brand-700 opacity-90">
        Shown once. All existing sessions were signed out.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="rounded border border-brand-200 bg-white px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">Sign in with</div>
          <div className="numeric break-all text-sm font-medium text-ink-900">{email}</div>
        </div>
        <div className="rounded border border-brand-200 bg-white px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-ink-500">Password</div>
          <div className="numeric break-all text-base font-bold tracking-wide text-ink-900">
            {password}
          </div>
        </div>
      </div>
    </div>
  );
}
