import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, EmptyState, Stat } from '@/components/ui';
import { money } from '@/lib/format';
import { CreateTestForm, PriceForm, CreateDoctorForm } from './forms';

export const dynamic = 'force-dynamic';

interface Test {
  id: string;
  code: string;
  name: string;
  department: string;
  version: number;
  price: string | number;
  tatMinutes: number | null;
  analytes: { analyte: { id: string; code: string; name: string } }[];
  specimenType: { name: string } | null;
}

interface Analyte {
  id: string;
  code: string;
  name: string;
  valueType: string;
  defaultUnit: string | null;
  usedInTests: number;
  referenceRangeCount: number;
}

interface Doctor {
  id: string;
  code: string;
  name: string;
  speciality: string | null;
  qualification: string | null;
  phone: string | null;
  isActive: boolean;
  orderCount: number;
}

export default async function CatalogAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const sp = await searchParams;
  const tab = sp.tab === 'doctors' ? 'doctors' : 'tests';
  const user = await getSessionUser();

  const [tests, analytes, doctors, refData] = await Promise.all([
    apiFetch<Test[]>('/catalog/tests').catch(() => [] as Test[]),
    apiFetch<Analyte[]>('/catalog/analytes').catch(() => [] as Analyte[]),
    apiFetch<Doctor[]>('/catalog/doctors?includeInactive=true').catch(() => [] as Doctor[]),
    apiFetch<{
      specimenTypes: { id: string; code: string; name: string }[];
      containerTypes: { id: string; code: string; name: string; colour: string | null }[];
    }>('/catalog/reference-data').catch(() => ({ specimenTypes: [], containerTypes: [] })),
  ]);

  async function createTest(formData: FormData): Promise<void> {
    'use server';
    const analyteIds = formData.getAll('analyteIds').map(String);
    await apiFetch('/catalog/tests', {
      method: 'POST',
      body: {
        code: String(formData.get('code') ?? '').trim(),
        name: String(formData.get('name') ?? '').trim(),
        department: String(formData.get('department') ?? 'BIOCHEMISTRY'),
        price: String(formData.get('price') ?? '0'),
        tatMinutes: String(formData.get('tatMinutes') ?? '').trim() || undefined,
        specimenTypeId: String(formData.get('specimenTypeId') ?? '') || undefined,
        containerTypeId: String(formData.get('containerTypeId') ?? '') || undefined,
        instructions: String(formData.get('instructions') ?? '').trim() || undefined,
        analytes: analyteIds.map((analyteId, i) => ({ analyteId, sortOrder: i })),
      },
    });
    revalidatePath('/admin/catalog');
  }

  async function updatePrice(testId: string, formData: FormData): Promise<void> {
    'use server';
    await apiFetch(`/catalog/tests/${testId}`, {
      method: 'PATCH',
      body: {
        price: String(formData.get('price') ?? '0'),
        reason: 'Price revision from the catalog screen',
      },
    });
    revalidatePath('/admin/catalog');
  }

  async function createDoctor(formData: FormData): Promise<void> {
    'use server';
    await apiFetch('/catalog/doctors', {
      method: 'POST',
      body: {
        name: String(formData.get('name') ?? '').trim(),
        code: String(formData.get('code') ?? '').trim() || undefined,
        speciality: String(formData.get('speciality') ?? '').trim() || undefined,
        qualification: String(formData.get('qualification') ?? '').trim() || undefined,
        registrationNo: String(formData.get('registrationNo') ?? '').trim() || undefined,
        phone: String(formData.get('phone') ?? '').trim() || undefined,
      },
    });
    revalidatePath('/admin/catalog');
  }

  const canManage = can(user, 'catalog:manage');
  const menuValue = tests.reduce((s, t) => s + Number(t.price), 0);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin" className="-ml-2 inline-flex min-h-11 items-center px-2 text-sm text-brand-600 hover:underline">
          ← Staff
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-ink-900">Test catalog</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          The menu the lab sells. Tests are deactivated, never deleted — an old report must still
          resolve the test that produced it.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Tests on the menu" value={tests.length} />
        <Stat label="Analytes defined" value={analytes.length} />
        <Stat label="Referring doctors" value={doctors.filter((d) => d.isActive).length} />
        <Stat
          label="Average price"
          value={tests.length ? money(menuValue / tests.length) : money(0)}
        />
      </div>

      <nav className="flex gap-1 border-b border-ink-200" aria-label="Catalog sections">
        {[
          { key: 'tests', label: 'Tests' },
          { key: 'doctors', label: 'Referring doctors' },
        ].map((t) => (
          <Link
            key={t.key}
            href={`/admin/catalog?tab=${t.key}`}
            aria-current={tab === t.key ? 'page' : undefined}
            className={`min-h-11 border-b-2 px-3 py-2 text-sm font-medium transition ${
              tab === t.key
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-ink-500 hover:text-ink-900'
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === 'tests' ? (
        <div className="grid gap-5 lg:grid-cols-3">
          {canManage && analytes.length > 0 && (
            <Card title="Add a test">
              <CreateTestForm
                action={createTest}
                analytes={analytes}
                specimenTypes={refData.specimenTypes}
                containerTypes={refData.containerTypes}
              />
            </Card>
          )}

          <Card
            className={canManage && analytes.length > 0 ? 'lg:col-span-2' : 'lg:col-span-3'}
            title={`Tests (${tests.length})`}
          >
            {tests.length === 0 ? (
              <EmptyState title="No tests defined" />
            ) : (
              <ul className="divide-y divide-ink-100">
                {tests.map((t) => (
                  <li key={t.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="numeric text-xs text-ink-500">{t.code}</span>
                          <span className="text-sm font-medium text-ink-900">{t.name}</span>
                          <span className="numeric rounded bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-500">
                            v{t.version}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-ink-500">
                          {t.department.replace(/_/g, ' ').toLowerCase()}
                          {t.specimenType && ` · ${t.specimenType.name}`}
                          {t.tatMinutes && ` · TAT ${t.tatMinutes} min`}
                          {' · '}
                          {t.analytes.length} analyte{t.analytes.length === 1 ? '' : 's'}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {t.analytes.slice(0, 12).map((a) => (
                            <span
                              key={a.analyte.id}
                              className="numeric rounded bg-ink-50 px-1.5 py-0.5 text-[10px] text-ink-500"
                            >
                              {a.analyte.code}
                            </span>
                          ))}
                          {t.analytes.length > 12 && (
                            <span className="text-[10px] text-ink-400">
                              +{t.analytes.length - 12}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="numeric text-sm font-semibold text-ink-900">
                          {money(Number(t.price))}
                        </div>
                        {canManage && (
                          <PriceForm
                            action={updatePrice.bind(null, t.id)}
                            current={Number(t.price)}
                            name={t.code}
                          />
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-3">
          {canManage && (
            <Card title="Add a referring doctor">
              <CreateDoctorForm action={createDoctor} />
            </Card>
          )}

          <Card
            className={canManage ? 'lg:col-span-2' : 'lg:col-span-3'}
            title={`Referring doctors (${doctors.length})`}
          >
            {doctors.length === 0 ? (
              <EmptyState
                title="No referring doctors"
                hint="Orders can still be registered as self-referred."
              />
            ) : (
              <ul className="divide-y divide-ink-100">
                {doctors.map((d) => (
                  <li
                    key={d.id}
                    className={`flex items-start justify-between gap-3 px-4 py-2.5 ${
                      d.isActive ? '' : 'opacity-50'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-ink-900">
                        {d.name}
                        {d.qualification && (
                          <span className="ml-1 font-normal text-ink-500">{d.qualification}</span>
                        )}
                      </div>
                      <div className="numeric truncate text-xs text-ink-500">
                        {d.code}
                        {d.speciality && ` · ${d.speciality}`}
                        {d.phone && ` · ${d.phone}`}
                        {!d.isActive && ' · inactive'}
                      </div>
                    </div>
                    <span className="numeric shrink-0 text-xs text-ink-500">
                      {d.orderCount} order{d.orderCount === 1 ? '' : 's'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
