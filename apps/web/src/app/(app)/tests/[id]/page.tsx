import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import { getSessionUser, can } from '@/lib/session';
import { Card, StatusPill, FlagBadge, SourceTag } from '@/components/ui';
import { enterResults, verifyTest, authorizeTest, rerunTest } from './actions';
import { ResultEntryForm, VerifyForm, AuthorizeForm, RerunForm } from './forms';

export const dynamic = 'force-dynamic';

interface TestDetail {
  id: string;
  status: string;
  priority: string;
  rerunCount: number;
  interpretation: string | null;
  enteredBy: string | null;
  verifiedAt: string | null;
  authorizedAt: string | null;
  dueAt: string | null;
  testDefinition: {
    code: string;
    name: string;
    department: string;
    requiresVerification: boolean;
    analytes: {
      sortOrder: number;
      formula: string | null;
      analyte: {
        id: string;
        code: string;
        name: string;
        valueType: string;
        defaultUnit: string | null;
        allowedValues: string[];
      };
    }[];
  };
  device: { id: string; code: string; name: string } | null;
  sample: {
    id: string;
    accessionNumber: string;
    status: string;
    patient: {
      id: string;
      patientCode: string;
      sex: string;
      ageYears: number | null;
    } | null;
  };
  /** Range that WILL apply, resolved per analyte even before any result exists. */
  applicableRanges: Record<string, string | null>;
  results: {
    id: string;
    analyteId: string;
    value: string | null;
    unit: string | null;
    refDisplay: string | null;
    flag: string;
    isCritical: boolean;
    source: string;
    version: number;
    deltaFlag: boolean;
    deltaPct: string | null;
    comment: string | null;
    analyte: { code: string; name: string };
  }[];
}

export default async function TestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();

  let test: TestDetail;
  try {
    test = await apiFetch<TestDetail>(`/tests/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const resultsByAnalyte = Object.fromEntries(
    test.results.map((r) => [r.analyteId, r.value ?? '']),
  );

  const analyteRows = test.testDefinition.analytes
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((a) => ({
      id: a.analyte.id,
      code: a.analyte.code,
      name: a.analyte.name,
      valueType: a.analyte.valueType,
      defaultUnit: a.analyte.defaultUnit,
      allowedValues: a.analyte.allowedValues,
      // Formula-derived analytes are computed server-side, not typed.
      isCalculated: a.formula !== null,
      // Prefer the range snapshotted onto an existing result (what was actually
      // applied); fall back to the range that will apply on entry.
      refDisplay:
        test.results.find((r) => r.analyteId === a.analyte.id)?.refDisplay ??
        test.applicableRanges?.[a.analyte.id] ??
        null,
    }));

  const canEnter =
    can(user, 'result:enter') && ['IN_PROGRESS', 'RESULT_ENTERED', 'TECH_VERIFIED'].includes(test.status);
  const canVerify = can(user, 'result:verify') && test.status === 'RESULT_ENTERED';
  const canAuthorize = can(user, 'result:authorize') && test.status === 'TECH_VERIFIED';
  const canRerun =
    can(user, 'result:rerun') &&
    ['IN_PROGRESS', 'RESULT_ENTERED', 'TECH_VERIFIED', 'AUTHORIZED', 'REPORTED'].includes(test.status);

  const criticals = test.results.filter((r) => r.isCritical);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Link href="/worklist" className="text-sm text-ink-500 hover:underline">
              ← Worklist
            </Link>
          </div>
          <h1 className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xl font-semibold text-ink-900">
            <span className="numeric">{test.sample.accessionNumber}</span>
            <StatusPill status={test.status} />
            {test.priority === 'STAT' && (
              <span className="rounded bg-[var(--color-critical)] px-2 py-0.5 text-xs font-bold text-white">
                STAT
              </span>
            )}
          </h1>
          <p className="mt-1 text-sm text-ink-600">
            {test.testDefinition.code} · {test.testDefinition.name}
            {test.sample.patient && (
              <>
                {' · '}
                {test.sample.patient.patientCode} ({test.sample.patient.sex[0]}/
                {test.sample.patient.ageYears ?? '?'})
              </>
            )}
            {test.device && <> · {test.device.code}</>}
          </p>
        </div>

        <Link
          href={`/audit?entityType=SampleTest&entityId=${test.id}`}
          className="rounded-md border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-100"
        >
          View history
        </Link>
      </div>

      {/* Critical values demand action before anything else on the page. */}
      {criticals.length > 0 && (
        <div className="rounded-lg border-2 border-[var(--color-critical)] bg-[var(--color-critical-bg)] px-4 py-3">
          <p className="text-sm font-bold text-[var(--color-critical)]">
            Critical value{criticals.length > 1 ? 's' : ''} — clinician must be notified
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {criticals.map((r) => (
              <li key={r.id} className="text-sm text-[var(--color-critical)]">
                <span className="font-medium">{r.analyte.name}</span>{' '}
                <span className="numeric font-bold">
                  {r.value} {r.unit}
                </span>{' '}
                <span className="opacity-75">(reference {r.refDisplay ?? 'n/a'})</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-[var(--color-critical)] opacity-80">
            Record the callback in the report notes. NABL expects evidence of the call,
            not just the flag.
          </p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Results */}
        <div className="space-y-5 lg:col-span-2">
          <Card title={canEnter ? 'Results' : 'Results (read-only)'}>
            <ResultEntryForm
              action={enterResults.bind(null, test.id)}
              analytes={analyteRows.filter((a) => !a.isCalculated)}
              existing={resultsByAnalyte}
              interpretation={test.interpretation}
              readOnly={!canEnter}
            />
          </Card>

          {test.results.length > 0 && (
            <Card title="Current values">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">Analyte</th>
                      <th className="px-4 py-2 font-medium">Value</th>
                      <th className="px-4 py-2 font-medium">Reference</th>
                      <th className="px-4 py-2 font-medium">Flag</th>
                      <th className="px-4 py-2 font-medium">Source</th>
                      <th className="px-4 py-2 font-medium">Ver.</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {test.results.map((r) => (
                      <tr key={r.id} className={r.isCritical ? 'bg-[var(--color-critical-bg)]' : ''}>
                        <td className="px-4 py-2">
                          <div className="font-medium text-ink-900">{r.analyte.name}</div>
                          <div className="text-xs text-ink-400">{r.analyte.code}</div>
                        </td>
                        <td className="numeric px-4 py-2 font-semibold text-ink-900">
                          {r.value} <span className="font-normal text-ink-500">{r.unit}</span>
                        </td>
                        <td className="numeric px-4 py-2 text-xs text-ink-500">
                          {r.refDisplay ?? '—'}
                        </td>
                        <td className="px-4 py-2">
                          <FlagBadge flag={r.flag} />
                          {r.deltaFlag && (
                            <span
                              title={`Changed ${r.deltaPct}% from this patient's previous result`}
                              className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                            >
                              Δ
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <SourceTag source={r.source} />
                        </td>
                        <td className="numeric px-4 py-2 text-xs text-ink-400">v{r.version}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {test.results.some((r) => r.version > 1) && (
                <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-500">
                  Superseded values are retained in the record and visible in the history.
                </p>
              )}
            </Card>
          )}
        </div>

        {/* Actions */}
        <div className="space-y-5">
          {canVerify && (
            <Card title="Technical verification">
              <div className="p-4">
                <VerifyForm action={verifyTest.bind(null, test.id)} />
              </div>
            </Card>
          )}

          {canAuthorize && (
            <Card title="Medical authorisation">
              <div className="p-4">
                <AuthorizeForm
                  action={authorizeTest.bind(null, test.id)}
                  mfaEnabled={user?.isMfaEnabled ?? false}
                />
              </div>
            </Card>
          )}

          {test.status === 'TECH_VERIFIED' && !canAuthorize && (
            <Card title="Awaiting authorisation">
              <p className="p-4 text-sm text-ink-600">
                These results are verified and waiting for a pathologist to authorise
                them. You do not hold <code className="text-xs">result:authorize</code>.
              </p>
            </Card>
          )}

          {['AUTHORIZED', 'REPORTED'].includes(test.status) && (
            <Card title="Authorised">
              <div className="space-y-2 p-4 text-sm text-ink-600">
                <p>
                  Signed and authorised
                  {test.authorizedAt && ` on ${new Date(test.authorizedAt).toLocaleString('en-IN')}`}
                  .
                </p>
                <p className="text-xs text-ink-500">
                  Changing an authorised value now requires a documented amendment with
                  a new signature.
                </p>
                <Link
                  href={`/samples/${test.sample.id}`}
                  className="inline-block rounded-md border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-100"
                >
                  Go to sample → report
                </Link>
              </div>
            </Card>
          )}

          {canRerun && <RerunForm action={rerunTest.bind(null, test.id)} />}

          <Card title="Workflow">
            <ol className="divide-y divide-ink-100 text-sm">
              {[
                ['Received', true],
                ['Results entered', ['RESULT_ENTERED', 'TECH_VERIFIED', 'AUTHORIZED', 'REPORTED'].includes(test.status)],
                ['Technically verified', ['TECH_VERIFIED', 'AUTHORIZED', 'REPORTED'].includes(test.status)],
                ['Medically authorised', ['AUTHORIZED', 'REPORTED'].includes(test.status)],
                ['Reported', test.status === 'REPORTED'],
              ].map(([label, done]) => (
                <li key={String(label)} className="flex items-center gap-3 px-4 py-2">
                  <span
                    className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                      done ? 'bg-emerald-500 text-white' : 'bg-ink-200 text-ink-400'
                    }`}
                  >
                    {done ? '✓' : ''}
                  </span>
                  <span className={done ? 'text-ink-900' : 'text-ink-400'}>{String(label)}</span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}
