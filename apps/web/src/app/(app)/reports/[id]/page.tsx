import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, FlagBadge, SourceTag, StatusPill } from '@/components/ui';
import { ReleaseForm } from './release-form';
import { AmendForm } from './amend-form';
import { releaseReport, amendReport } from './actions';

export const dynamic = 'force-dynamic';

interface Report {
  id: string;
  reportNumber: string;
  version: number;
  status: string;
  isPartial: boolean;
  amendmentReason: string | null;
  releasedAt: string | null;
  lab: {
    name: string;
    address: string | null;
    city: string | null;
    phone: string | null;
    nablCertNo: string | null;
  };
  patient: { code: string; name: string; sex: string; ageYears: number | null };
  referredBy: string;
  orderNumber: string;
  tests: {
    code: string;
    name: string;
    department: string;
    method: string | null;
    accessionNumber: string;
    collectedAt: string | null;
    interpretation: string | null;
    results: {
      analyteCode: string;
      analyteName: string;
      value: string | null;
      unit: string | null;
      referenceRange: string | null;
      flag: string;
      isCritical: boolean;
      source: string;
      version: number;
    }[];
  }[];
  signatures: {
    meaning: string;
    signedAt: string;
    by: string;
    qualification: string | null;
    registrationNo: string | null;
  }[];
}

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();

  let report: Report;
  try {
    report = await apiFetch<Report>(`/reports/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const canRelease = can(user, 'report:release') && report.status === 'DRAFT';
  // Only a released report can be amended: a draft is simply corrected and
  // regenerated, with nothing yet in the patient's hands to supersede.
  const canAmend = can(user, 'report:amend') && report.status === 'RELEASED';

  return (
    <div className="space-y-5">
      <div className="no-print flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/worklist" className="text-sm text-ink-500 hover:underline">
            ← Worklist
          </Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xl font-semibold text-ink-900">
            <span className="numeric">{report.reportNumber}</span>
            <span className="text-sm font-normal text-ink-500">v{report.version}</span>
            <StatusPill status={report.status} />
            {report.isPartial && (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                partial
              </span>
            )}
          </h1>
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-3">
        {/* The report as the patient receives it. */}
        <div className="min-w-0 lg:col-span-2">
          <Card className="print:border-0">
            <div className="border-b-2 border-ink-900 px-6 py-4">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-bold text-ink-900">{report.lab.name}</h2>
                  <p className="text-xs text-ink-600">
                    {[report.lab.address, report.lab.city].filter(Boolean).join(', ')}
                    {report.lab.phone && ` · ${report.lab.phone}`}
                  </p>
                </div>
                {report.lab.nablCertNo && (
                  <div className="text-right text-xs">
                    <div className="font-semibold text-ink-900">NABL Accredited</div>
                    <div className="numeric text-ink-600">{report.lab.nablCertNo}</div>
                  </div>
                )}
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 border-b border-ink-200 px-6 py-3 text-sm sm:grid-cols-4">
              <Field label="Patient" value={report.patient.name} />
              <Field label="ID" value={report.patient.code} mono />
              <Field
                label="Age / Sex"
                value={`${report.patient.ageYears ?? '—'} / ${report.patient.sex[0]}`}
              />
              <Field label="Referred by" value={report.referredBy} />
              <Field label="Report no." value={`${report.reportNumber} v${report.version}`} mono />
              <Field label="Order" value={report.orderNumber} mono />
              <Field
                label="Released"
                value={
                  report.releasedAt
                    ? new Date(report.releasedAt).toLocaleString('en-IN')
                    : 'Not yet released'
                }
              />
            </dl>

            {report.tests.map((test) => (
              <div key={test.accessionNumber + test.code} className="border-b border-ink-200">
                <div className="flex items-baseline justify-between bg-ink-50 px-6 py-2">
                  <h3 className="text-sm font-bold uppercase tracking-wide text-ink-900">
                    {test.name}
                  </h3>
                  <span className="numeric text-xs text-ink-500">{test.accessionNumber}</span>
                </div>

                {/* Mobile: stacked rows. This is the screen most likely to be
                    opened on a phone, so it must not scroll sideways. */}
                <ul className="divide-y divide-ink-100 sm:hidden">
                  {test.results.map((r) => (
                    <li
                      key={r.analyteCode}
                      className={`px-4 py-2.5 ${r.isCritical ? 'bg-[var(--color-critical-bg)]' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className="min-w-0 flex-1 text-sm text-ink-800">{r.analyteName}</span>
                        <span
                          className={`numeric shrink-0 text-sm font-semibold ${
                            r.isCritical
                              ? 'text-[var(--color-critical)]'
                              : r.flag === 'NORMAL'
                                ? 'text-ink-900'
                                : 'text-[var(--color-high)]'
                          }`}
                        >
                          {r.value} <span className="font-normal text-ink-500">{r.unit ?? ''}</span>
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="numeric text-xs text-ink-500">
                          {r.referenceRange ? `Ref: ${r.referenceRange}` : ''}
                        </span>
                        <FlagBadge flag={r.flag} />
                      </div>
                    </li>
                  ))}
                </ul>

                <table className="hidden w-full text-sm sm:table">
                  <thead className="text-left text-xs uppercase tracking-wide text-ink-500">
                    <tr>
                      <th className="px-6 py-1.5 font-medium">Investigation</th>
                      <th className="px-3 py-1.5 font-medium">Result</th>
                      <th className="px-3 py-1.5 font-medium">Unit</th>
                      <th className="px-3 py-1.5 font-medium">Reference</th>
                      <th className="px-3 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {test.results.map((r) => (
                      <tr
                        key={r.analyteCode}
                        className={r.isCritical ? 'bg-[var(--color-critical-bg)]' : ''}
                      >
                        <td className="px-6 py-1.5 text-ink-800">{r.analyteName}</td>
                        <td
                          className={`numeric px-3 py-1.5 font-semibold ${
                            r.flag === 'NORMAL' ? 'text-ink-900' : 'text-[var(--color-high)]'
                          } ${r.isCritical ? 'text-[var(--color-critical)]' : ''}`}
                        >
                          {r.value}
                        </td>
                        <td className="px-3 py-1.5 text-ink-500">{r.unit ?? ''}</td>
                        <td className="numeric px-3 py-1.5 text-xs text-ink-500">
                          {r.referenceRange ?? ''}
                        </td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <FlagBadge flag={r.flag} />
                            <span className="no-print">
                              <SourceTag source={r.source} />
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {test.method && (
                  <p className="px-6 pb-2 text-xs text-ink-400">Method: {test.method}</p>
                )}
                {test.interpretation && (
                  <p className="border-t border-ink-100 px-6 py-2 text-sm text-ink-700">
                    <span className="font-medium">Interpretation: </span>
                    {test.interpretation}
                  </p>
                )}
              </div>
            ))}

            {/* Signatures are what make this a report rather than a printout. */}
            <div className="px-6 py-4">
              <div className="flex flex-wrap gap-8">
                {report.signatures
                  .filter((s) => s.meaning === 'AUTHORIZED')
                  .map((s, i) => (
                    <div key={i} className="text-sm">
                      <div className="border-b border-ink-400 pb-1 font-medium text-ink-900">
                        {s.by}
                      </div>
                      <div className="mt-1 text-xs text-ink-600">
                        {s.qualification ?? ''}
                        {s.registrationNo && <> · Reg. {s.registrationNo}</>}
                      </div>
                      <div className="text-xs text-ink-400">
                        Electronically signed {new Date(s.signedAt).toLocaleString('en-IN')}
                      </div>
                    </div>
                  ))}
              </div>

              {report.isPartial && (
                <p className="mt-4 text-xs italic text-ink-500">
                  This is a partial report. Tests still in progress will be issued separately.
                </p>
              )}
              {report.amendmentReason && (
                <p className="mt-4 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <span className="font-medium">Amended report. </span>
                  {report.amendmentReason}
                </p>
              )}
              <p className="mt-3 text-[10px] leading-relaxed text-ink-400">
                Results relate only to the sample tested. This report is electronically
                signed and does not require a physical signature.
              </p>
            </div>
          </Card>
        </div>

        {/* Actions */}
        <div className="no-print space-y-5">
          {canRelease && (
            <Card title="Release to patient">
              <div className="p-4">
                <ReleaseForm action={releaseReport.bind(null, report.id)} mfaEnabled={user?.isMfaEnabled ?? false} />
              </div>
            </Card>
          )}

          {report.status === 'RELEASED' && (
            <Card title="Released">
              <div className="space-y-2 p-4 text-sm text-ink-600">
                <p>
                  Released{' '}
                  {report.releasedAt && new Date(report.releasedAt).toLocaleString('en-IN')}.
                </p>
                <p className="text-xs text-ink-500">
                  This version is preserved permanently. A correction creates version{' '}
                  {report.version + 1} with a documented reason — it never overwrites what the
                  patient already received.
                </p>
              </div>
            </Card>
          )}

          {canAmend && (
            <Card title="Correct a released report">
              <AmendForm
                action={amendReport.bind(null, report.id)}
                mfaEnabled={user?.isMfaEnabled ?? false}
              />
            </Card>
          )}

          <Card title="Signatures">
            {report.signatures.length === 0 ? (
              <p className="p-4 text-sm text-ink-500">Not yet signed.</p>
            ) : (
              <ul className="divide-y divide-ink-100 text-sm">
                {report.signatures.map((s, i) => (
                  <li key={i} className="px-4 py-2">
                    <div className="font-medium text-ink-900">{s.by}</div>
                    <div className="text-xs text-ink-500">
                      {s.meaning.toLowerCase()} · {new Date(s.signedAt).toLocaleString('en-IN')}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className={`text-ink-900 ${mono ? 'numeric' : ''}`}>{value}</dd>
    </div>
  );
}
