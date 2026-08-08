import { redirect } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import { getSessionUser } from '@/lib/session';
import { Card, ErrorBanner } from '@/components/ui';
import { RegisterForm } from './form';

export const dynamic = 'force-dynamic';

interface TestOption {
  id: string;
  code: string;
  name: string;
  department: string;
  price: string;
  tatMinutes: number | null;
  instructions: string | null;
}

interface PanelOption {
  id: string;
  code: string;
  name: string;
  price: string;
  items: { testDefinition: { code: string; name: string } }[];
}

/**
 * Registers a patient and places the order in one action.
 *
 * Deliberately one step: a front desk gets interrupted constantly, and splitting
 * this across two submits leaves orphaned patients with no order behind.
 */
async function register(formData: FormData): Promise<void> {
  'use server';

  const labId = String(formData.get('labId') ?? '');
  const testIds = formData.getAll('testId').map(String).filter(Boolean);
  const panelIds = formData.getAll('panelId').map(String).filter(Boolean);

  if (testIds.length === 0 && panelIds.length === 0) {
    redirect('/register?error=' + encodeURIComponent('Select at least one test or package.'));
  }

  const ageYears = Number(formData.get('ageYears'));

  let patientId: string;
  try {
    const patient = await apiFetch<{ id: string; patientCode: string }>('/patients', {
      method: 'POST',
      body: {
        fullName: String(formData.get('fullName') ?? '').trim(),
        sex: String(formData.get('sex') ?? 'UNKNOWN'),
        ageYears: Number.isFinite(ageYears) && ageYears > 0 ? ageYears : undefined,
        phone: String(formData.get('phone') ?? '').trim() || undefined,
        email: String(formData.get('email') ?? '').trim() || undefined,
        // Consent is captured at registration, in the same breath as the phone
        // number it governs — DPDP purpose limitation is easiest to honour when
        // it is not a separate screen someone can skip.
        consents: [
          { purpose: 'DIAGNOSTIC_SERVICE', granted: true, noticeVersion: 'v1' },
          {
            purpose: 'REPORT_DELIVERY',
            granted: formData.get('consentDelivery') === 'on',
            noticeVersion: 'v1',
          },
        ],
      },
    });
    patientId = patient.id;
  } catch (err) {
    const message = err instanceof ApiError ? err.message : 'Could not register the patient.';
    redirect('/register?error=' + encodeURIComponent(message));
  }

  let orderId: string;
  try {
    const order = await apiFetch<{ id: string; orderNumber: string }>('/orders', {
      method: 'POST',
      body: {
        labId,
        patientId,
        priority: String(formData.get('priority') ?? 'ROUTINE'),
        clinicalNotes: String(formData.get('clinicalNotes') ?? '').trim() || undefined,
        items: [
          ...testIds.map((testDefinitionId) => ({ testDefinitionId })),
          ...panelIds.map((panelId) => ({ panelId })),
        ],
        createSample: true,
      },
    });
    orderId = order.id;
  } catch (err) {
    const message = err instanceof ApiError ? err.message : 'Could not create the order.';
    redirect('/register?error=' + encodeURIComponent(message));
  }

  redirect(`/orders/${orderId}`);
}

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const user = await getSessionUser();

  const [tests, panels] = await Promise.all([
    apiFetch<TestOption[]>('/catalog/tests').catch(() => []),
    apiFetch<PanelOption[]>('/catalog/panels').catch(() => []),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Register patient &amp; order tests</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Creates the patient, the order, the sample(s) and the invoice in one step.
        </p>
      </div>

      {params.error && <ErrorBanner message={params.error} />}

      <Card>
        <RegisterForm
          action={register}
          labs={user?.labs ?? []}
          tests={tests}
          panels={panels}
        />
      </Card>
    </div>
  );
}
