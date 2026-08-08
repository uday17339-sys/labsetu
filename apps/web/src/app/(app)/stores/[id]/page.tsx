import Link from 'next/link';
import { notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, EmptyState, StatusPill } from '@/components/ui';
import { date, dateTime } from '@/lib/format';
import { IssueForm, MoveForm, RequestSamplingForm } from '../forms';

export const dynamic = 'force-dynamic';

interface Batch {
  id: string;
  batchNumber: string;
  manufacturerLot: string | null;
  material: {
    id: string;
    code: string;
    name: string;
    type: string;
    unit: string;
    pharmacopoeia: string | null;
    storageCondition: string | null;
    handlingNotes: string | null;
  };
  goodsReceipt: {
    grnNumber: string;
    supplier: string;
    invoiceRef: string | null;
    poReference: string | null;
    receivedAt: string;
    receiptCheckNote: string | null;
  } | null;
  quantityReceived: number;
  quantityAvailable: number;
  unit: string;
  containerCount: number | null;
  status: string;
  location: string | null;
  manufacturedAt: string | null;
  expiryDate: string | null;
  retestDate: string | null;
  isExpired: boolean;
  isRetestDue: boolean;
  isIssuable: boolean;
  blockedByInvestigation: boolean;
  samplingRequests: {
    id: string;
    requestNumber: string;
    reason: string;
    status: string;
    note: string | null;
    requestedAt: string;
    sampledAt: string | null;
    containersSampled: number | null;
    quantitySampled: number | null;
    orderId: string | null;
  }[];
  orders: {
    id: string;
    orderNumber: string;
    status: string;
    orderedAt: string;
    samples: {
      id: string;
      accessionNumber: string;
      status: string;
      tests: { id: string; code: string; name: string; status: string }[];
    }[];
  }[];
  dispositions: {
    id: string;
    decision: string;
    rationale: string;
    deviationRef: string | null;
    decidedAt: string;
  }[];
  investigations: {
    id: string;
    investigationNumber: string;
    analyteCode: string;
    observedValue: string;
    limitBreached: string;
    phase: string;
    status: string;
    conclusion: string | null;
    openedAt: string;
  }[];
  certificates: { id: string; coaNumber: string; version: number; issuedAt: string }[];
}

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();

  const batch = await apiFetch<Batch>(`/stores/batches/${id}`).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });
  if (!batch) notFound();

  async function issue(formData: FormData): Promise<void> {
    'use server';
    await apiFetch(`/stores/batches/${id}/issue`, {
      method: 'POST',
      body: {
        quantity: String(formData.get('quantity') ?? ''),
        reference: String(formData.get('reference') ?? '').trim(),
      },
    });
    revalidatePath(`/stores/${id}`);
    revalidatePath('/stores');
  }

  async function move(formData: FormData): Promise<void> {
    'use server';
    await apiFetch(`/stores/batches/${id}/move`, {
      method: 'POST',
      body: {
        location: String(formData.get('location') ?? '').trim(),
        reason: String(formData.get('reason') ?? '').trim(),
      },
    });
    revalidatePath(`/stores/${id}`);
  }

  async function requestSampling(formData: FormData): Promise<void> {
    'use server';
    await apiFetch('/stores/sampling-requests', {
      method: 'POST',
      body: {
        batchId: id,
        reason: String(formData.get('reason') ?? 'RELEASE_TESTING'),
        note: String(formData.get('note') ?? '').trim() || undefined,
      },
    });
    revalidatePath(`/stores/${id}`);
    revalidatePath('/stores');
  }

  const openInvestigations = batch.investigations.filter((i) => i.status !== 'CLOSED');

  return (
    <div className="space-y-5">
      <div>
        <Link
          href="/stores"
          className="-ml-2 inline-flex min-h-11 items-center px-2 text-sm text-brand-600 hover:underline"
        >
          ← Stores
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-words text-xl font-semibold text-ink-900">
              {batch.material.name}
            </h1>
            <div className="numeric mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-500">
              <StatusPill status={batch.status} />
              <span>batch {batch.batchNumber}</span>
              <span>· {batch.material.code}</span>
              {batch.location && <span>· {batch.location}</span>}
            </div>
          </div>
          {can(user, 'batch:disposition') && batch.status === 'UNDER_TEST' && (
            <Link
              href={`/qa/${batch.id}`}
              className="min-h-11 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Review for release
            </Link>
          )}
        </div>
      </div>

      {batch.isExpired && (
        <div className="rounded-lg border-2 border-[var(--color-critical)] bg-[var(--color-critical-bg)] px-4 py-3">
          <p className="text-sm font-bold text-[var(--color-critical)]">
            Expired {date(batch.expiryDate)}
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-critical)] opacity-90">
            Approval does not survive expiry. This material cannot be issued.
          </p>
        </div>
      )}

      {batch.isRetestDue && !batch.isExpired && (
        <div className="rounded-lg border border-orange-300 bg-orange-50 px-4 py-3">
          <p className="text-sm font-medium text-orange-900">
            Past its retest date of {date(batch.retestDate)}
          </p>
          <p className="mt-0.5 text-xs text-orange-800">
            Raise a retest sampling request before issuing any of it.
          </p>
        </div>
      )}

      {openInvestigations.length > 0 && (
        <div className="rounded-lg border-2 border-[var(--color-critical)] bg-[var(--color-critical-bg)] px-4 py-3">
          <p className="text-sm font-bold text-[var(--color-critical)]">
            {openInvestigations.length} open out-of-specification investigation
            {openInvestigations.length > 1 ? 's' : ''}
          </p>
          <ul className="mt-1.5 space-y-0.5 text-xs text-[var(--color-critical)]">
            {openInvestigations.map((i) => (
              <li key={i.id} className="numeric">
                {i.investigationNumber} — {i.analyteCode} {i.observedValue} against{' '}
                {i.limitBreached} ({i.phase.replace('_', ' ')})
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-[var(--color-critical)] opacity-90">
            This batch cannot be released until they are closed.
          </p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Batch record">
            <dl className="grid gap-x-6 sm:grid-cols-2">
              <Row label="Material type">
                {batch.material.type.replace(/_/g, ' ').toLowerCase()}
              </Row>
              <Row label="Pharmacopoeia">{batch.material.pharmacopoeia ?? '—'}</Row>
              <Row label="Supplier lot">{batch.manufacturerLot ?? '—'}</Row>
              <Row label="Containers">{batch.containerCount ?? '—'}</Row>
              <Row label="Received">
                {batch.quantityReceived} {batch.unit}
              </Row>
              <Row label="Available">
                <span
                  className={
                    batch.isIssuable ? 'font-semibold text-[var(--color-normal)]' : 'text-ink-900'
                  }
                >
                  {batch.quantityAvailable} {batch.unit}
                </span>
              </Row>
              <Row label="Manufactured">{date(batch.manufacturedAt)}</Row>
              <Row label="Expiry">{date(batch.expiryDate)}</Row>
              <Row label="Retest due">{date(batch.retestDate)}</Row>
              <Row label="Storage">{batch.material.storageCondition ?? '—'}</Row>
              {batch.goodsReceipt && (
                <>
                  <Row label="GRN">{batch.goodsReceipt.grnNumber}</Row>
                  <Row label="Supplier">{batch.goodsReceipt.supplier}</Row>
                  <Row label="Invoice">{batch.goodsReceipt.invoiceRef ?? '—'}</Row>
                  <Row label="Received on">{dateTime(batch.goodsReceipt.receivedAt)}</Row>
                </>
              )}
            </dl>
            {batch.goodsReceipt?.receiptCheckNote && (
              <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-600">
                <span className="font-medium">Receipt check:</span>{' '}
                {batch.goodsReceipt.receiptCheckNote}
              </p>
            )}
            {batch.material.handlingNotes && (
              <p className="border-t border-ink-100 px-4 py-2 text-xs text-[var(--color-high)]">
                <span className="font-medium">Handling:</span> {batch.material.handlingNotes}
              </p>
            )}
          </Card>

          <Card title={`Testing (${batch.orders.length} order${batch.orders.length === 1 ? '' : 's'})`}>
            {batch.orders.length === 0 ? (
              <EmptyState
                title="Not yet sampled"
                hint="QC raises the test order when it draws the sample."
              />
            ) : (
              <ul className="divide-y divide-ink-100">
                {batch.orders.map((o) => (
                  <li key={o.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="numeric text-sm font-medium text-ink-900">
                        {o.orderNumber}
                      </span>
                      <span className="numeric text-xs text-ink-400">{dateTime(o.orderedAt)}</span>
                    </div>
                    {o.samples.map((s) => (
                      <div key={s.id} className="mt-1.5">
                        <Link
                          href={`/samples/${s.id}`}
                          className="numeric -ml-2 inline-flex min-h-11 items-center px-2 text-xs font-medium text-brand-600 hover:underline"
                        >
                          {s.accessionNumber}
                        </Link>
                        <ul className="mt-1 space-y-1">
                          {s.tests.map((t) => (
                            <li
                              key={t.id}
                              className="flex items-center justify-between gap-2 text-xs"
                            >
                              <Link
                                href={`/tests/${t.id}`}
                                className="-ml-2 inline-flex min-h-11 min-w-0 items-center truncate px-2 text-ink-700 hover:underline"
                              >
                                <span className="numeric text-ink-500">{t.code}</span> {t.name}
                              </Link>
                              <StatusPill status={t.status} />
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {batch.dispositions.length > 0 && (
            <Card title="Disposition history">
              <ul className="divide-y divide-ink-100">
                {batch.dispositions.map((d) => (
                  <li key={d.id} className="px-4 py-2.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span
                        className={`text-sm font-medium ${
                          d.decision === 'REJECTED'
                            ? 'text-[var(--color-critical)]'
                            : 'text-[var(--color-normal)]'
                        }`}
                      >
                        {d.decision.replace(/_/g, ' ').toLowerCase()}
                      </span>
                      <span className="numeric text-xs text-ink-400">{dateTime(d.decidedAt)}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-600">{d.rationale}</p>
                    {d.deviationRef && (
                      <p className="numeric mt-0.5 text-xs text-ink-500">
                        Deviation {d.deviationRef}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-400">
                Append-only. A reversal is recorded as a new decision, never as an edit.
              </p>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          {can(user, 'sampling:request') &&
            ['QUARANTINE', 'APPROVED', 'RETEST_DUE'].includes(batch.status) && (
              <Card title="Request QC sampling">
                <div className="p-4">
                  <RequestSamplingForm action={requestSampling} />
                </div>
              </Card>
            )}

          {can(user, 'stores:manage') && batch.isIssuable && (
            <Card title="Issue to production">
              <IssueForm
                action={issue}
                available={batch.quantityAvailable}
                unit={batch.unit}
              />
            </Card>
          )}

          {can(user, 'stores:manage') && !batch.isIssuable && batch.status !== 'CONSUMED' && (
            <Card title="Issue to production">
              <p className="p-4 text-sm text-ink-500">
                This batch is{' '}
                <span className="font-medium">
                  {batch.status.replace(/_/g, ' ').toLowerCase()}
                </span>
                {batch.isExpired && ' and has expired'}. Only QA-approved material may leave the
                store.
              </p>
            </Card>
          )}

          {can(user, 'stores:manage') && (
            <Card title="Move">
              <MoveForm action={move} />
            </Card>
          )}

          {batch.samplingRequests.length > 0 && (
            <Card title="Sampling requests">
              <ul className="divide-y divide-ink-100">
                {batch.samplingRequests.map((r) => (
                  <li key={r.id} className="px-4 py-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="numeric text-xs font-medium text-ink-900">
                        {r.requestNumber}
                      </span>
                      <StatusPill status={r.status} />
                    </div>
                    <div className="mt-0.5 text-xs text-ink-500">
                      {r.reason.replace(/_/g, ' ').toLowerCase()} · {dateTime(r.requestedAt)}
                    </div>
                    {r.sampledAt && (
                      <div className="numeric text-xs text-ink-500">
                        Sampled {dateTime(r.sampledAt)}
                        {r.containersSampled != null && ` · ${r.containersSampled} containers`}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {batch.certificates.length > 0 && (
            <Card title="Certificates of analysis">
              <ul className="divide-y divide-ink-100">
                {batch.certificates.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/coa/${c.id}`}
                      className="flex min-h-11 items-center justify-between gap-2 px-4 py-2.5 hover:bg-ink-50"
                    >
                      <span className="numeric text-sm text-brand-600">
                        {c.coaNumber}
                        {c.version > 1 && <span className="ml-1 text-xs">v{c.version}</span>}
                      </span>
                      <span className="numeric text-xs text-ink-400">{date(c.issuedAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-ink-100 px-4 py-2 text-sm">
      <dt className="shrink-0 text-ink-500">{label}</dt>
      <dd className="numeric min-w-0 text-right text-ink-900">{children}</dd>
    </div>
  );
}
