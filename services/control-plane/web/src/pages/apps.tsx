/** Every app at a glance, trouble first: health, traffic, errors, latency, alerts, cost and last deploy. */
import { useAtomValue } from '@effect/atom-react';
import type { AppSummary } from '@ericminassian/platform-core';
import { Link, useNavigate } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Sparkline } from '../components/charts/sparkline.tsx';
import { columns, DataTable } from '../components/data-table.tsx';
import {
  EmptyState,
  Loaded,
  Mono,
  PageHeader,
  Panel,
  Stat,
  StatusDot,
  StatusPill,
  statusTone,
  type Tone,
} from '../components/page.tsx';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../components/ui/input-group.tsx';
import { appsAtom } from '../data/atoms.ts';
import { fmtMs, fmtNum, fmtPct, fmtUsd, relTime } from '../format.ts';
import { useAutoRefresh } from '../lib/hooks.ts';

/** How an app is doing, as one word: firing alerts and a down prod come first. */
export function appHealth(s: AppSummary): { tone: Tone; label: string; rank: number } {
  const alarms = s.alerts?.alarm ?? 0;
  if (alarms > 0) return { tone: 'bad', label: alarms === 1 ? '1 alert' : `${alarms} alerts`, rank: 0 };
  if (!s.health) return { tone: 'muted', label: 'No prod', rank: 4 };
  if (s.health.up === false) return { tone: 'bad', label: 'Down', rank: 1 };
  if (s.health.errorRate > 0.05) return { tone: 'warn', label: 'Errors', rank: 2 };
  if (s.health.up === null) return { tone: 'muted', label: 'Unknown', rank: 3 };
  return { tone: 'ok', label: 'Up', rank: 3 };
}

const col = columns<AppSummary>();

const appColumns = col.columns([
  col.accessor((s) => s.app.name, {
    id: 'app',
    header: 'App',
    cell: ({ row }) => {
      const s = row.original;
      const prod = s.stages.find((st) => st.stage === 'prod');
      return (
        <div className="flex min-w-0 items-center gap-3">
          <StatusDot tone={appHealth(s).tone} label={appHealth(s).label} />
          <div className="min-w-0">
            <Link
              to="/apps/$app"
              params={{ app: s.app.name }}
              className="font-medium hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {s.app.name}
            </Link>
            <div className="max-w-80 truncate text-xs text-muted-foreground">
              {s.app.description ?? prod?.host ?? s.app.repo}
            </div>
          </div>
        </div>
      );
    },
  }),
  col.accessor((s) => appHealth(s).rank, {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => {
      const h = appHealth(row.original);
      return <StatusPill tone={h.tone}>{h.label}</StatusPill>;
    },
  }),
  col.accessor((s) => s.health?.reqPerMin ?? -1, {
    id: 'traffic',
    header: 'Requests, 24h',
    cell: ({ row }) => {
      const s = row.original;
      return (
        <div className="flex items-center gap-3">
          <Sparkline values={s.traffic ?? []} width={96} height={22} />
          <span className="text-xs text-muted-foreground tabular">
            {s.health ? `${fmtNum(s.health.reqPerMin)}/min` : '–'}
          </span>
        </div>
      );
    },
  }),
  col.accessor((s) => s.health?.errorRate ?? -1, {
    id: 'errors',
    header: '5xx',
    meta: { numeric: true },
    cell: ({ row }) => {
      const rate = row.original.health?.errorRate;
      return (
        <span className={rate !== undefined && rate > 0.01 ? 'text-bad' : undefined}>
          {rate === undefined ? '–' : fmtPct(rate)}
        </span>
      );
    },
  }),
  col.accessor((s) => s.health?.p95 ?? -1, {
    id: 'p95',
    header: 'p95',
    meta: { numeric: true },
    cell: ({ row }) => fmtMs(row.original.health?.p95),
  }),
  col.accessor((s) => s.costMonthToDateUsd ?? -1, {
    id: 'cost',
    header: 'Cost, month to date',
    meta: { numeric: true },
    cell: ({ row }) => fmtUsd(row.original.costMonthToDateUsd),
  }),
  col.accessor((s) => s.lastDeployment?.createdAt ?? '', {
    id: 'deployed',
    header: 'Last deploy',
    cell: ({ row }) => {
      const d = row.original.lastDeployment;
      if (!d) return <span className="text-muted-foreground">Never deployed</span>;
      return (
        <div className="flex items-center gap-2 whitespace-nowrap">
          <StatusDot tone={statusTone(d.status)} label={d.status} />
          <Mono className="text-muted-foreground">{d.commit?.slice(0, 7) ?? d.stage}</Mono>
          <span className="text-muted-foreground">{relTime(d.createdAt)}</span>
        </div>
      );
    },
  }),
]);

export function AppsPage() {
  const result = useAtomValue(appsAtom);
  useAutoRefresh(appsAtom, true);
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  return (
    <>
      <PageHeader
        title="Apps"
        description="Each app's production stage over the last hour, and its last 24 hours of traffic."
      />
      <Loaded result={result}>
        {(apps) => (
          <AppsBody
            apps={apps}
            filter={filter}
            setFilter={setFilter}
            onOpen={(app) => void navigate({ to: '/apps/$app', params: { app } })}
          />
        )}
      </Loaded>
    </>
  );
}

function AppsBody({
  apps,
  filter,
  setFilter,
  onOpen,
}: {
  apps: readonly AppSummary[];
  filter: string;
  setFilter: (v: string) => void;
  onOpen: (app: string) => void;
}) {
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const matching = f
      ? apps.filter((s) =>
          [s.app.name, s.app.description ?? '', s.app.repo].some((v) => v.toLowerCase().includes(f)),
        )
      : apps;
    // Trouble first, then by name.
    return matching.toSorted(
      (a, b) => appHealth(a).rank - appHealth(b).rank || a.app.name.localeCompare(b.app.name),
    );
  }, [apps, filter]);

  if (apps.length === 0) {
    return (
      <Panel>
        <EmptyState title="No apps yet">
          Create one with <Mono>plat init my-app</Mono>, then{' '}
          <Mono>plat apps create my-app --repo you/my-app</Mono>.
        </EmptyState>
      </Panel>
    );
  }

  const firing = apps.reduce((n, s) => n + (s.alerts?.alarm ?? 0), 0);
  const down = apps.filter((s) => s.health?.up === false).length;
  const reqPerMin = apps.reduce((n, s) => n + (s.health?.reqPerMin ?? 0), 0);
  const cost = apps.reduce((n, s) => n + (s.costMonthToDateUsd ?? 0), 0);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Apps"
          value={apps.length}
          note={`${apps.filter((s) => s.health).length} with a prod stage`}
        />
        <Stat
          label="Firing alerts"
          value={firing}
          tone={firing ? 'bad' : undefined}
          note={down ? `${down} prod ${down === 1 ? 'stage' : 'stages'} down` : 'every prod stage up'}
        />
        <Stat label="Requests" value={`${fmtNum(reqPerMin)}/min`} note="all prod stages, last hour" />
        <Stat label="Cost, month to date" value={fmtUsd(cost)} note="tagged to apps" />
      </div>
      <Panel
        flush
        title={`${shown.length} ${shown.length === 1 ? 'app' : 'apps'}`}
        actions={
          <InputGroup className="h-8 w-64">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Filter apps"
              placeholder="Filter by name or repo"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </InputGroup>
        }
      >
        <DataTable
          columns={appColumns}
          data={shown}
          getRowId={(s) => s.app.name}
          onRowClick={(s) => onOpen(s.app.name)}
          empty={<EmptyState title="No app matches">Try another name.</EmptyState>}
        />
      </Panel>
    </div>
  );
}
