import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import { Card } from '@/components/ui';
import { date, dateTime } from '@/lib/format';
import { PrintButton } from './print-button';

export const dynamic = 'force-dynamic';

interface Coa {
  id: string;
  coaNumber: string;
  version: number;
  issuedAt: string;
  contentHash: string | null;
  issuer: { legalName: string; gstin: string | null };
  material: { code: string; name: string; type: string; pharmacopoeia: string | null };
  batch: {
    batchNumber: string;
    manufacturerLot: string | null;
    quantityReceived: number;
    unit: string;
    manufacturedAt: string | null;
    expiryDate: string | null;
    retestDate: string | null;
    supplier: string | null;
  };
  specification: { code: string; version: number; basis: string | null };
  results: {
    parameter: string;
    code: string;
    criterion: string;
    result: string;
    unit: string | null;
    verdict: string;
    isCritical: boolean;
  }[];
  disposition: {
    decision: string;
    rationale: string;
    deviationRef: string | null;
    decidedAt: string;
  } | null;
  conclusion: string;
}

export default async function CoaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const coa = await apiFetch<Coa>(`/qa/coa/${id}`).catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });
  if (!coa) notFound();

  return (
    <div className="space-y-5">
      <div className="no-print flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href="/stores"
            className="-ml-2 inline-flex min-h-11 items-center px-2 text-sm text-brand-600 hover:underline"
          >
            ← Stores
          </Link>
          <h1 className="numeric mt-1 break-words text-xl font-semibold text-ink-900">
            {coa.coaNumber}
            {coa.version > 1 && (
              <span className="ml-2 text-base font-normal text-ink-500">v{coa.version}</span>
            )}
          </h1>
        </div>
        <PrintButton />
      </div>

      <Card>
        <div className="space-y-5 p-5">
          <div className="border-b border-ink-200 pb-4 text-center">
            <h2 className="text-lg font-bold uppercase tracking-wide text-ink-900">
              Certificate of Analysis
            </h2>
            <p className="mt-1 text-sm font-medium text-ink-700">{coa.issuer.legalName}</p>
            {coa.issuer.gstin && (
              <p className="numeric text-xs text-ink-500">GSTIN {coa.issuer.gstin}</p>
            )}
          </div>

          <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
            <Field label="Certificate no." value={coa.coaNumber} />
            <Field label="Issued" value={date(coa.issuedAt)} />
            <Field label="Material" value={coa.material.name} />
            <Field label="Material code" value={coa.material.code} />
            <Field label="Batch no." value={coa.batch.batchNumber} />
            <Field label="Supplier lot" value={coa.batch.manufacturerLot ?? '—'} />
            <Field
              label="Quantity"
              value={`${coa.batch.quantityReceived} ${coa.batch.unit}`}
            />
            <Field label="Supplier" value={coa.batch.supplier ?? '—'} />
            <Field label="Manufactured" value={date(coa.batch.manufacturedAt)} />
            <Field label="Expiry" value={date(coa.batch.expiryDate)} />
            <Field label="Retest by" value={date(coa.batch.retestDate)} />
            <Field
              label="Specification"
              value={`${coa.specification.code} v${coa.specification.version}`}
            />
            {coa.specification.basis && (
              <Field label="Basis" value={coa.specification.basis} full />
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border border-ink-300 text-sm">
              <thead className="border-b border-ink-300 bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-600">
                <tr>
                  <th className="border-r border-ink-200 px-3 py-2 font-semibold">Parameter</th>
                  <th className="border-r border-ink-200 px-3 py-2 font-semibold">
                    Acceptance criterion
                  </th>
                  <th className="border-r border-ink-200 px-3 py-2 font-semibold">Result</th>
                  <th className="px-3 py-2 font-semibold">Remark</th>
                </tr>
              </thead>
              <tbody>
                {coa.results.map((r) => (
                  <tr key={r.code} className="border-b border-ink-200 last:border-b-0">
                    <td className="border-r border-ink-200 px-3 py-2 text-ink-900">
                      {r.parameter}
                    </td>
                    <td className="numeric border-r border-ink-200 px-3 py-2 text-ink-700">
                      {r.criterion}
                    </td>
                    <td className="numeric border-r border-ink-200 px-3 py-2 font-medium text-ink-900">
                      {r.result}
                      {r.unit && <span className="ml-1 font-normal text-ink-500">{r.unit}</span>}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {r.verdict === 'PASS' ? (
                        <span className="font-medium text-[var(--color-normal)]">Complies</span>
                      ) : r.verdict === 'FAIL' ? (
                        <span className="font-bold text-[var(--color-critical)]">
                          Does not comply
                        </span>
                      ) : r.verdict === 'NOT_TESTED' ? (
                        <span className="text-ink-400">Not tested</span>
                      ) : (
                        <span className="text-ink-600">Complies</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded border border-ink-300 bg-ink-50 px-4 py-3">
            <p className="text-sm font-medium text-ink-900">Conclusion</p>
            <p className="mt-0.5 text-sm text-ink-700">{coa.conclusion}</p>
            {coa.disposition && (
              <>
                <p className="mt-2 text-xs text-ink-600">
                  <span className="font-medium">
                    {coa.disposition.decision.replace(/_/g, ' ').toLowerCase()}
                  </span>{' '}
                  · {dateTime(coa.disposition.decidedAt)}
                </p>
                <p className="mt-0.5 text-xs text-ink-600">{coa.disposition.rationale}</p>
                {coa.disposition.deviationRef && (
                  <p className="numeric mt-0.5 text-xs text-ink-600">
                    Deviation {coa.disposition.deviationRef}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="border-t border-ink-200 pt-3">
            <p className="text-xs text-ink-500">
              Released by Quality Assurance under electronic signature. This certificate is
              generated from the laboratory record and is valid without a manual signature.
            </p>
            {coa.contentHash && (
              <p className="numeric mt-1 break-all text-[10px] text-ink-400">
                Content hash {coa.contentHash}
              </p>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

function Field({ label, value, full }: { label: string; value: string; full?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 border-b border-ink-100 py-1.5 text-sm ${full ? 'sm:col-span-2' : ''}`}>
      <span className="shrink-0 text-ink-500">{label}</span>
      <span className="numeric min-w-0 text-right font-medium text-ink-900">{value}</span>
    </div>
  );
}
