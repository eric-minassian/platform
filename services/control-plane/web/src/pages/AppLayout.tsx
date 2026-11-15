import type { AppSummary } from '@eric-minassian/platform-core';
import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useOutletContext, useParams, useSearchParams } from 'react-router';
import { api, type Scope } from '../api.ts';
import { Badge, cx, Dot, Loaded, Select, statusTone } from '../components/ui.tsx';
import { healthTone } from './Apps.tsx';

export interface AppContext {
  summary: AppSummary;
  app: string;
  scope: Scope;
  /** Query string preserving stage + range, for links between tabs. */
  search: string;
}

export const useApp = () => useOutletContext<AppContext>();

const RANGES = ['1h', '6h', '24h', '7d', '30d'];
const TABS = [
  ['', 'Overview'],
  ['requests', 'Requests'],
  ['logs', 'Logs'],
  ['traces', 'Traces'],
  ['errors', 'Errors'],
  ['jobs', 'Jobs'],
  ['data', 'Data'],
  ['deployments', 'Deployments'],
  ['secrets', 'Secrets'],
  ['cost', 'Cost'],
  ['settings', 'Settings'],
] as const;

export function AppLayout() {
  const { app = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ['app', app], queryFn: () => api.app(app), refetchInterval: 30_000 });
  const stage = params.get('stage') ?? 'prod';
  const range = params.get('range') ?? '24h';
  const set = (k: string, v: string) =>
    setParams((p) => {
      p.set(k, v);
      return p;
    });
  const search = `?stage=${encodeURIComponent(stage)}&range=${range}`;

  return (
    <Loaded q={q}>
      {(summary) => {
        const current = summary.stages.find((s) => s.stage === stage);
        const stageOptions = summary.stages.length
          ? summary.stages.map((s) => ({ value: s.stage, label: s.stage }))
          : [{ value: 'prod', label: 'prod' }];
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="flex items-center gap-2 text-lg font-semibold">
                <Dot tone={healthTone(summary)} />
                {summary.app.name}
              </h1>
              {current && <Badge tone={statusTone(current.status)}>{current.status}</Badge>}
              {current && (
                <a
                  href={current.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12px] text-accent hover:underline"
                >
                  {current.host} ↗
                </a>
              )}
              <a
                href={`https://github.com/${summary.app.repo}`}
                target="_blank"
                rel="noreferrer"
                className="text-[12px] text-muted hover:text-fg"
              >
                {summary.app.repo}
              </a>
              <div className="ml-auto flex items-center gap-2">
                <Select value={stage} onChange={(v) => set('stage', v)} options={stageOptions} />
                <Select
                  value={range}
                  onChange={(v) => set('range', v)}
                  options={RANGES.map((r) => ({ value: r, label: r }))}
                />
              </div>
            </div>
            <nav className="flex gap-1 overflow-x-auto border-b border-border">
              {TABS.map(([path, label]) => (
                <NavLink
                  key={path}
                  end={path === ''}
                  to={`/apps/${app}${path ? `/${path}` : ''}${search}`}
                  className={({ isActive }) =>
                    cx(
                      '-mb-px border-b-2 px-2.5 py-1.5 text-[12px] whitespace-nowrap',
                      isActive ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg',
                    )
                  }
                >
                  {label}
                </NavLink>
              ))}
            </nav>
            <Outlet context={{ summary, app, scope: { stage, range }, search } satisfies AppContext} />
          </div>
        );
      }}
    </Loaded>
  );
}
