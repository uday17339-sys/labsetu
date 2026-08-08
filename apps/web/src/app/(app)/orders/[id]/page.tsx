import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, StatusPill } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  priority: string;
  clinicalNotes: string | null;
  orderedAt: string;
  patient: { id: string; patientCode: string; sex: string; ageYears: number | null };
  referringDoctor: { name: string; qualification: string | null } | null;
  lab: { code: string; name: string };
  items: {
    id: string;
    netAmount: string;
    testDefinition: { code: string; name: string } | null;
    panel: { code: string; name: string } | null;
  }[];
  samples: {
    id: string;
    accessionNumber: string;
    barcode: string | null;
    status: string;
    tests: { id: string; status: string; testDefinition: { code: string; name: string } }[];
  }[];
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let order: Order;
  try {
    order = await apiFetch<Order>(`/orders/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const total = order.items.reduce((sum, i) => sum + Number(i.netAmount), 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">
          Registered — <span className="numeric">{order.orderNumber}</span>
        </h1>
        <p className="mt-0.5 text-sm text-ink-500">
          {order.patient.patientCode} ({order.patient.sex[0]}/{order.patient.ageYears ?? '?'}) ·{' '}
          {order.lab.code} · {new Date(order.orderedAt).toLocaleString('en-IN')}
        </p>
      </div>

      <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3">
        <p className="text-sm font-medium text-emerald-900">
          {order.samples.length} sample{order.samples.length === 1 ? '' : 's'} accessioned. Print
          the labels and collect.
        </p>
        <p className="mt-0.5 text-xs text-emerald-800">
          Tests were grouped by specimen type, so each tube below serves every test that shares
          its requirement.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Samples to collect">
          <div className="divide-y divide-ink-100">
            {order.samples.map((s) => (
              <div key={s.id} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <Link
                      href={`/samples/${s.id}`}
                      className="numeric text-lg font-semibold text-brand-600 hover:underline"
                    >
                      {s.accessionNumber}
                    </Link>
                    <StatusPill status={s.status} />
                  </div>
                  {/* Stand-in for a real ZPL label. Phase 1 sends this to a
                      Zebra/TSC printer instead. */}
                  <div className="rounded border border-ink-300 bg-white px-3 py-1.5">
                    <div className="text-[10px] uppercase tracking-widest text-ink-400">
                      barcode
                    </div>
                    <div className="numeric font-mono text-sm tracking-[0.2em] text-ink-900">
                      {s.barcode ?? s.accessionNumber}
                    </div>
                  </div>
                </div>
                <p className="mt-2 text-sm text-ink-600">
                  {s.tests.map((t) => t.testDefinition.code).join(' · ')}
                </p>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Invoice">
          <ul className="divide-y divide-ink-100 text-sm">
            {order.items.map((i) => (
              <li key={i.id} className="flex justify-between gap-4 px-4 py-2">
                <span className="text-ink-700">
                  {i.testDefinition?.name ?? i.panel?.name ?? '—'}
                </span>
                <span className="numeric text-ink-900">₹{Number(i.netAmount)}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between border-t border-ink-200 px-4 py-2.5 font-semibold">
            <span className="text-ink-900">Total</span>
            <span className="numeric text-ink-900">₹{total.toLocaleString('en-IN')}</span>
          </div>
          <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-400">
            Diagnostic services are largely GST-exempt; the tax breakdown appears on
            non-clinical lines.
          </p>
        </Card>
      </div>

      <div className="flex gap-3">
        <Link
          href="/register"
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Register another
        </Link>
        <Link
          href="/worklist"
          className="rounded-md border border-ink-300 px-4 py-2 text-sm text-ink-700 hover:bg-ink-100"
        >
          Go to worklist
        </Link>
      </div>
    </div>
  );
}
