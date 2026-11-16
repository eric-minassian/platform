/**
 * What an app costs: Cost Explorer's daily cost of everything tagged to it,
 * what its servers would cost a month in each compute mode (the chooser's
 * daily estimate, and how far along a switch is), and its services that
 * bill for as long as they run.
 */
import { useAtomValue } from '@effect/atom-react';
import type { AlwaysOnCost, StageCompute } from '@ericminassian/platform-core';
import { Atom } from 'effect/reactivity';
import type { ReactElement } from 'react';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { DailyCostChart } from '../../components/cost/daily-cost-chart.tsx';
import { columns, DataTable } from '../../components/data-table.tsx';
import { Loaded, Mono, PageHeader, Panel, Stat, StatusPill } from '../../components/page.tsx';
import { fmtNum, fmtUsd, fmtUsdCents, fmtUsdEstimate, relTime } from '../../format.ts';
import { appRoute } from '../../router.tsx';

// Cost Explorer refreshes daily and charges per request, so an hour-old answer is fresh enough.
const costAtom = Atom.family((app: string) =>
  fresh(ApiClient.query('observe', 'cost', { params: { app }, query: { days: 35 }, timeToLive }), {
    staleTime: '1 hour',
  }),
);

const MODE = { request: 'Request mode', instance: 'Instance mode' } as const;

export function CostPage(): ReactElement {
  const { app } = appRoute.useParams();
  const result = useAtomValue(costAtom(app));
  return (
    <>
      <PageHeader
        title="Cost"
        description="Cost Explorer's figures for resources tagged to this app, refreshed daily."
      />
      <Loaded result={result}>
        {(c) => {
          const last7 = c.days.slice(-7).reduce((a, d) => a + d.usd, 0);
          const average = c.days.length ? c.days.reduce((a, d) => a + d.usd, 0) / c.days.length : 0;
          const alwaysOn = (c.alwaysOn ?? []).reduce((a, s) => a + s.monthly.totalUsd, 0);
          return (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat
                  label="Month to date"
                  value={fmtUsd(c.monthToDateUsd)}
                  note="this calendar month, UTC"
                />
                <Stat label="Last 7 days" value={fmtUsd(last7)} note="the latest day may be partial" />
                <Stat label="Daily average" value={fmtUsd(average)} note={`over ${c.days.length} days`} />
                <Stat
                  label="Always-on services"
                  value={c.alwaysOn?.length ? `≈ ${fmtUsdCents(alwaysOn)}` : '–'}
                  note={c.alwaysOn?.length ? 'a month, if they run all month' : 'none'}
                />
              </div>
              <Panel
                title="Cost per day"
                description="Resources tagged to the app. Shared platform resources (router, tables, buckets) count under Platform."
              >
                <DailyCostChart
                  series={[{ key: 'usd', label: 'Cost', color: 'var(--chart-1)', days: c.days }]}
                  ariaLabel={`${app} cost per day`}
                />
              </Panel>
              {c.compute && c.compute.length > 0 && <Compute stages={c.compute} />}
              {c.alwaysOn && c.alwaysOn.length > 0 && <AlwaysOn services={c.alwaysOn} />}
            </div>
          );
        }}
      </Loaded>
    </>
  );
}

const compute = columns<StageCompute>();
const computeColumns = compute.columns([
  compute.accessor('stage', {
    header: 'Stage',
    enableSorting: false,
    cell: ({ getValue }) => <Mono>{getValue()}</Mono>,
  }),
  compute.accessor('compute', {
    header: 'Runs in',
    enableSorting: false,
    cell: ({ row }) => {
      const s = row.original;
      return (
        <div>
          <StatusPill tone="info">{MODE[s.compute]}</StatusPill>
          {s.streak && (
            <div className="mt-1 text-xs text-muted-foreground">
              {MODE[s.streak.to].toLowerCase()} cheaper, day {s.streak.days} of 3
            </div>
          )}
        </div>
      );
    },
  }),
  compute.accessor('setting', {
    header: () => <Mono className="text-xs">web.compute</Mono>,
    enableSorting: false,
    cell: ({ getValue }) => <Mono>{getValue()}</Mono>,
  }),
  compute.accessor((s) => s.estimate?.request.monthlyUsd ?? -1, {
    id: 'request',
    header: 'Request mode',
    enableSorting: false,
    meta: { numeric: true },
    cell: ({ row }) => {
      const e = row.original.estimate;
      if (!e) return <span className="text-muted-foreground">–</span>;
      return (
        <Estimate
          usd={e.request.monthlyUsd}
          cheaper={e.request.monthlyUsd < e.instance.monthlyUsd}
          detail={`${fmtNum(e.request.coldStartsPerMonth)} cold starts`}
        />
      );
    },
  }),
  compute.accessor((s) => s.estimate?.instance.monthlyUsd ?? -1, {
    id: 'instance',
    header: 'Instance mode',
    enableSorting: false,
    meta: { numeric: true },
    cell: ({ row }) => {
      const e = row.original.estimate;
      if (!e) return <span className="text-muted-foreground">–</span>;
      return (
        <Estimate
          usd={e.instance.monthlyUsd}
          cheaper={e.instance.monthlyUsd < e.request.monthlyUsd}
          detail={`${fmtNum(e.instance.environmentHoursPerMonth)} environment hours`}
        />
      );
    },
  }),
  compute.accessor((s) => s.estimate?.requestsPerMonth ?? -1, {
    id: 'requests',
    header: 'Requests a month',
    enableSorting: false,
    meta: { numeric: true },
    cell: ({ row }) => {
      const e = row.original.estimate;
      if (!e) return <span className="text-muted-foreground">–</span>;
      return (
        <div>
          <div>{fmtNum(e.requestsPerMonth)}</div>
          <div className="text-xs text-muted-foreground">
            from {e.days} {e.days === 1 ? 'day' : 'days'}, {relTime(e.at)}
          </div>
        </div>
      );
    },
  }),
]);

function Estimate({ usd, cheaper, detail }: { usd: number; cheaper: boolean; detail: string }) {
  return (
    <div>
      <div className={cheaper ? 'text-ok' : undefined}>≈ {fmtUsdEstimate(usd)}</div>
      <div className="text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function Compute({ stages }: { stages: readonly StageCompute[] }) {
  return (
    <Panel
      flush
      title="Server compute, per month"
      description="Each mode priced daily from the stage's recent traffic, before the free tier"
    >
      <DataTable columns={computeColumns} data={stages} getRowId={(s) => s.stage} />
      <p className="border-t px-4 pt-2.5 pb-1.5 text-xs text-muted-foreground">
        On <Mono className="text-xs">auto</Mono>, a stage moves to the other mode once it has cost 25% less
        three days running. Previews always run in request mode.
      </p>
    </Panel>
  );
}

const always = columns<AlwaysOnCost>();
const alwaysColumns = always.columns([
  always.accessor('stage', { header: 'Stage', cell: ({ getValue }) => <Mono>{getValue()}</Mono> }),
  always.accessor('name', { header: 'Service', cell: ({ getValue }) => <Mono>{getValue()}</Mono> }),
  always.accessor('detail', { header: 'Size', enableSorting: false }),
  always.accessor((a) => a.monthly.computeUsd, {
    id: 'compute',
    header: 'Compute',
    meta: { numeric: true },
    cell: ({ getValue }) => fmtUsdCents(getValue()),
  }),
  always.accessor((a) => a.monthly.publicIpv4Usd, {
    id: 'ipv4',
    header: 'Public IPv4',
    meta: { numeric: true },
    cell: ({ getValue }) => fmtUsdCents(getValue()),
  }),
  always.accessor((a) => a.monthly.totalUsd, {
    id: 'total',
    header: 'Monthly',
    meta: { numeric: true },
    cell: ({ getValue }) => <span className="font-medium">{fmtUsdCents(getValue())}</span>,
  }),
]);

function AlwaysOn({ services }: { services: readonly AlwaysOnCost[] }) {
  return (
    <Panel flush title="Always on" description="Estimated from each service's size, running all month">
      <DataTable
        columns={alwaysColumns}
        data={services}
        getRowId={(a) => `${a.stage}:${a.kind}:${a.name}`}
        initialSorting={[{ id: 'total', desc: true }]}
      />
      <p className="border-t px-4 pt-2.5 pb-1.5 text-xs text-muted-foreground">
        Cost Explorer doesn't attribute a container's public IPv4 address to the app; it's counted with the
        shared platform resources under Platform.
      </p>
    </Panel>
  );
}
