import { apiFetch } from '@/lib/api';
import { Card, EmptyState, Stat, StatusPill } from '@/components/ui';
import { dateTime, duration } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface Device {
  id: string;
  code: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  department: string;
  protocol: string;
  status: string;
  isActive: boolean;
  isShadowMode: boolean;
  lab: { code: string; name: string } | null;
  channelCount: number;
  lastMessageAt: string | null;
  minutesSinceLastMessage: number | null;
  isOnline: boolean;
  openExceptions: number;
}

export default async function DevicesPage() {
  const devices = await apiFetch<Device[]>('/ingest/devices').catch(() => [] as Device[]);

  const active = devices.filter((d) => d.isActive);
  const online = active.filter((d) => d.isOnline);
  const silent = active.filter((d) => d.status === 'ACTIVE' && !d.isOnline);
  const exceptions = devices.reduce((s, d) => s + d.openExceptions, 0);

  return (
    <div className="space-y-5">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-ink-900">Instruments</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Analysers connected through the on-premise gateway. Results arrive over ASTM, HL7 or a
          watched folder and are never auto-authorised.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Connected" value={active.length} />
        <Stat label="Online now" value={online.length} tone={online.length ? 'good' : 'default'} />
        <Stat
          label="Silent"
          value={silent.length}
          tone={silent.length > 0 ? 'critical' : 'default'}
        />
        <Stat
          label="Held results"
          value={exceptions}
          tone={exceptions > 0 ? 'warn' : 'default'}
        />
      </div>

      {/* "We didn't notice it stopped sending" is the failure mode that actually
          bites labs — an analyser can be silently offline for a whole shift. */}
      {silent.length > 0 && (
        <div className="rounded-lg border-2 border-[var(--color-critical)] bg-[var(--color-critical-bg)] px-4 py-3">
          <p className="text-sm font-bold text-[var(--color-critical)]">
            {silent.length} analyser{silent.length > 1 ? 's have' : ' has'} stopped sending
          </p>
          <ul className="mt-1.5 space-y-0.5 text-xs text-[var(--color-critical)]">
            {silent.map((d) => (
              <li key={d.id}>
                {d.name} — last message{' '}
                {d.minutesSinceLastMessage != null
                  ? `${duration(d.minutesSinceLastMessage)} ago`
                  : 'never'}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Card title={`Instruments (${devices.length})`}>
        {devices.length === 0 ? (
          <EmptyState
            title="No instruments enrolled"
            hint="Instruments are enrolled from the on-premise gateway using a one-time code."
          />
        ) : (
          <ul className="divide-y divide-ink-100">
            {devices.map((d) => (
              <li key={d.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          d.isOnline
                            ? 'bg-[var(--color-normal)]'
                            : d.isActive
                              ? 'bg-[var(--color-critical)]'
                              : 'bg-ink-300'
                        }`}
                      />
                      <span className="text-sm font-medium text-ink-900">{d.name}</span>
                      <span className="numeric text-xs text-ink-500">{d.code}</span>
                      <StatusPill status={d.status} />
                      {d.isShadowMode && (
                        <span
                          title="Results are captured and parsed but never written to the clinical record. This is how a new analyser is commissioned safely."
                          className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 ring-1 ring-violet-200"
                        >
                          shadow mode
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-500">
                      {[d.manufacturer, d.model].filter(Boolean).join(' ') || '—'} ·{' '}
                      {d.department.replace(/_/g, ' ').toLowerCase()} ·{' '}
                      {d.protocol.replace(/_/g, ' ')}
                      {d.lab && ` · ${d.lab.name}`}
                      {' · '}
                      {d.channelCount} channel{d.channelCount === 1 ? '' : 's'}
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    <div
                      className={`text-xs font-medium ${
                        d.isOnline ? 'text-[var(--color-normal)]' : 'text-ink-500'
                      }`}
                    >
                      {d.isOnline
                        ? 'online'
                        : d.minutesSinceLastMessage != null
                          ? `silent ${duration(d.minutesSinceLastMessage)}`
                          : 'never connected'}
                    </div>
                    <div className="numeric mt-0.5 text-[10px] text-ink-400">
                      {d.lastMessageAt ? dateTime(d.lastMessageAt) : '—'}
                    </div>
                    {d.openExceptions > 0 && (
                      <div className="mt-0.5 text-[10px] font-medium text-[var(--color-high)]">
                        {d.openExceptions} held result{d.openExceptions > 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-ink-100 px-4 py-2 text-xs text-ink-400">
          An instrument is treated as online if it has sent anything in the last 15 minutes.
          Instrument results always land at &ldquo;result entered&rdquo; and still require human
          verification and authorisation.
        </p>
      </Card>
    </div>
  );
}
