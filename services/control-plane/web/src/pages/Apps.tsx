import { useAtomValue } from '@effect/atom-react';
import type { AppSummary } from '@ericminassian/platform-core';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { Link } from 'react-router';
import { ApiClient, fresh, timeToLive } from '../client.ts';
import { Badge, Dot, Empty, Loaded, Mono, statusTone, type Tone } from '../components/ui.tsx';
import { fmtMs, fmtNum, fmtPct, fmtUsd, relTime } from '../format.ts';

export function healthTone(s: AppSummary): Tone {
  if (!s.health) return 'muted';
  if (s.health.up === false) return 'bad';
  if (s.health.errorRate > 0.05) return 'warn';
  return s.health.up ? 'ok' : 'muted';
}

/** Reactivity key of the apps list. */
export const appsChanged = ['apps'];

const appsAtom = fresh(ApiClient.query('apps', 'list', { reactivityKeys: appsChanged, timeToLive }), {
  every: '60 seconds',
});

function AppCard({ s }: { s: AppSummary }) {
  const prod = s.stages.find((st) => st.stage === 'prod');
  const previews = s.stages.filter((st) => st.preview).length;
  return (
    <Link
      to={`/apps/${s.app.name}`}
      className="group flex flex-col gap-3 rounded-lg border border-border bg-panel p-3 transition hover:border-accent/60"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium">
            <Dot tone={healthTone(s)} />
            <span className="truncate">{s.app.name}</span>
          </div>
          <div className="mt-0.5 truncate text-[12px] text-muted">
            {s.app.description ?? prod?.host ?? s.app.repo}
          </div>
        </div>
        {s.lastDeployment && (
          <Badge tone={statusTone(s.lastDeployment.status)}>{s.lastDeployment.status}</Badge>
        )}
      </div>
      <div className="grid grid-cols-4 gap-2 text-[11px] text-muted">
        <Metric label="req/min" value={fmtNum(s.health?.reqPerMin)} />
        <Metric label="errors" value={fmtPct(s.health?.errorRate)} />
        <Metric label="p95" value={fmtMs(s.health?.p95)} />
        <Metric label="cost MTD" value={fmtUsd(s.costMonthToDateUsd)} />
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>
          {prod ? 'prod' : 'no prod'}
          {previews ? ` · ${previews} preview${previews > 1 ? 's' : ''}` : ''}
        </span>
        <span>{s.lastDeployment ? `deployed ${relTime(s.lastDeployment.createdAt)}` : 'never deployed'}</span>
      </div>
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[13px] font-medium text-fg tabular-nums">{value}</div>
      {label}
    </div>
  );
}

export function AppsPage() {
  const result = useAtomValue(appsAtom);
  const apps = Option.getOrUndefined(AsyncResult.value(result));
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <h1 className="text-lg font-semibold">Apps</h1>
        {apps && <span className="text-[12px] text-muted">{apps.length} apps</span>}
      </div>
      <Loaded result={result}>
        {(apps) =>
          apps.length === 0 ? (
            <div className="rounded-lg border border-border bg-panel">
              <Empty>
                No apps yet. Create one with <Mono>plat init my-app</Mono>, then{' '}
                <Mono>plat apps create my-app --repo you/my-app</Mono>.
              </Empty>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {apps.map((s) => (
                <AppCard key={s.app.name} s={s} />
              ))}
            </div>
          )
        }
      </Loaded>
    </div>
  );
}
