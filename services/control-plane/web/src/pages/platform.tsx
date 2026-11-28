/**
 * The platform as a whole, for admins: how much is live, what the account
 * costs and how much of that is the shared platform, the edge's per-client
 * floor, and who the members are under which limits.
 */
import { useAtomValue } from '@effect/atom-react';
import type { AdminOverview, EdgeFloorResponse, EdgeFloorSample } from '@ericminassian/platform-core';
import type { ReactElement } from 'react';
import { ApiClient, fresh, timeToLive } from '../client.ts';
import { type CostSeries, DailyCostChart } from '../components/cost/daily-cost-chart.tsx';
import { columns, DataTable } from '../components/data-table.tsx';
import { Loaded, Mono, PageHeader, Panel, Stat, Stats, StatusPill } from '../components/page.tsx';
import { type PointSeries, PointsChart } from '../components/points/points-chart.tsx';
import { fmtDateTime, fmtNum, fmtPct, fmtUsd, relTime } from '../format.ts';

const overviewAtom = fresh(ApiClient.query('admin', 'overview', { timeToLive }), { staleTime: '5 minutes' });
// The floor's state changes within a minute of the edge getting busy.
const edgeAtom = fresh(ApiClient.query('admin', 'edge', { query: { range: '24h' }, timeToLive }), {
  every: '60 seconds',
});

export function PlatformPage(): ReactElement {
  const result = useAtomValue(overviewAtom);
  return (
    <>
      <PageHeader title="Platform" description="Every app, the account's cost, the edge and the members." />
      <Loaded result={result}>{(o) => <Overview overview={o} />}</Loaded>
    </>
  );
}

function Overview({ overview: o }: { overview: AdminOverview }) {
  return (
    <div className="flex flex-col gap-5">
      <Stats>
        <Stat label="Apps" value={fmtNum(o.apps)} />
        <Stat
          label="Live stages"
          value={fmtNum(o.stages)}
          note={`including ${fmtNum(o.previews)} ${o.previews === 1 ? 'preview' : 'previews'}`}
        />
        <Stat
          label="Down"
          value={fmtNum(o.down.length)}
          tone={o.down.length ? 'bad' : undefined}
          note={o.down.length ? o.down.join(', ') : 'every uptime check passing'}
        />
        <Stat
          label="Account, month to date"
          value={fmtUsd(o.cost.total?.monthToDateUsd)}
          note={o.cost.total ? 'Cost Explorer, refreshed daily' : 'not available'}
        />
        <Stat
          label="Shared platform, month to date"
          value={fmtUsd(o.cost.shared?.monthToDateUsd)}
          note="resources not tagged to an app"
        />
      </Stats>
      <AccountCost overview={o} />
      <EdgeFloor />
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <Members overview={o} />
        <Limits limits={o.limits} />
      </div>
    </div>
  );
}

/**
 * The account's daily cost, split into the shared platform (router, tables,
 * buckets: everything not tagged to an app) and the rest, which add up to
 * the account's total.
 */
function AccountCost({ overview: o }: { overview: AdminOverview }) {
  const total = o.cost.total;
  if (!total) return null;
  const shared = new Map((o.cost.shared?.days ?? []).map((d) => [d.date, d.usd]));
  const series: CostSeries[] = o.cost.shared
    ? [
        {
          key: 'shared',
          label: 'Shared platform',
          color: 'var(--chart-2)',
          days: total.days.map((d) => ({ date: d.date, usd: Math.min(shared.get(d.date) ?? 0, d.usd) })),
        },
        {
          key: 'rest',
          label: 'Apps and everything else',
          color: 'var(--chart-1)',
          days: total.days.map((d) => ({
            date: d.date,
            usd: Math.max(d.usd - (shared.get(d.date) ?? 0), 0),
          })),
        },
      ]
    : [{ key: 'total', label: 'Account', color: 'var(--chart-1)', days: total.days }];
  return (
    <Panel title="Account cost per day" description={`Last ${total.days.length} days, UTC`}>
      <DailyCostChart series={series} ariaLabel="Account cost per day" />
    </Panel>
  );
}

const EDGE_SERIES: readonly PointSeries<'allowed' | 'blocked'>[] = [
  { key: 'allowed', label: 'Allowed', color: 'var(--chart-1)' },
  { key: 'blocked', label: 'Blocked', color: 'var(--s4xx)' },
];

/**
 * The edge's per-client request floor, for every app: whether it's on (it is
 * only while the whole edge is busy), and over the last 24 hours how many
 * requests it blocked and when. While it's on, a sample of whom it blocked on
 * which host (WAF samples a share of requests, from the last three hours).
 */
function EdgeFloor() {
  const result = useAtomValue(edgeAtom);
  return (
    <Loaded result={result} loading={<Panel title="Edge floor">{null}</Panel>}>
      {(e) => <EdgeFloorBody edge={e} />}
    </Loaded>
  );
}

function EdgeFloorBody({ edge: e }: { edge: EdgeFloorResponse }) {
  const { on, since, why } = e.state;
  if (!e.enabled && !on) {
    return (
      <Panel title="Edge floor" actions={<StatusPill tone="muted">Not set up</StatusPill>}>
        <p className="text-sm text-muted-foreground">
          Set <Mono>limits.edgeRequestsPerMinute</Mono> and <Mono>limits.edgeFloorAt</Mono> in{' '}
          <Mono>platform.config.ts</Mono> and deploy the platform to block floods at the edge.
        </p>
      </Panel>
    );
  }
  const seen = e.totals.blocked + e.totals.allowed;
  return (
    <Panel
      title="Edge floor"
      description="Per-client request limit at the edge, on only while the whole edge is busy"
      actions={<StatusPill tone={on ? 'warn' : 'muted'}>{on ? 'On' : 'Off'}</StatusPill>}
      bodyClassName="flex flex-col gap-4"
    >
      <Stats>
        <Stat
          label="State"
          value={on ? 'On' : 'Off'}
          tone={on ? 'warn' : undefined}
          note={
            on && since
              ? `since ${fmtDateTime(since)}`
              : `turns on at ${e.threshold === undefined ? '—' : fmtNum(e.threshold)} requests a minute`
          }
        />
        <Stat
          label="Limit"
          value={e.limit === undefined ? '—' : e.limit.toLocaleString('en')}
          note="requests per client per app per minute"
        />
        <Stat
          label="Blocked, 24h"
          value={fmtNum(e.totals.blocked)}
          tone={e.totals.blocked ? 'warn' : undefined}
          note={seen ? `${fmtPct(e.totals.blocked / seen, 2)} of requests seen` : 'nothing seen'}
        />
        <Stat label="Allowed, 24h" value={fmtNum(e.totals.allowed)} note="requests the web ACL let through" />
      </Stats>
      {why && since && (
        <p className="text-sm text-muted-foreground">
          {on ? 'Turned on' : 'Turned off'} {relTime(since)}: {why}.
        </p>
      )}
      {seen > 0 ? (
        <PointsChart
          points={e.points}
          res={e.res}
          series={EDGE_SERIES}
          kind="bar"
          format={fmtNum}
          height={180}
          ariaLabel="Requests the edge floor allowed and blocked"
        />
      ) : (
        <p className="text-sm text-muted-foreground">No requests reached the floor in the last 24 hours.</p>
      )}
      {on && (
        <div className="-mx-5 border-t">
          <DataTable
            columns={sampleColumns}
            data={e.samples.slice(0, 20)}
            getRowId={(s, i) => `${s.at}:${s.client}:${s.path}:${i}`}
            dense
            empty={
              <p className="px-5 py-6 text-sm text-muted-foreground">
                Nothing blocked in the last three hours.
              </p>
            }
          />
        </div>
      )}
    </Panel>
  );
}

const sample = columns<EdgeFloorSample>();
const sampleColumns = sample.columns([
  sample.accessor('at', {
    header: 'Blocked at',
    cell: ({ getValue }) => <span className="whitespace-nowrap tabular">{fmtDateTime(getValue())}</span>,
  }),
  sample.accessor('host', { header: 'Host', cell: ({ getValue }) => <Mono>{getValue()}</Mono> }),
  sample.accessor('client', {
    header: 'Client',
    cell: ({ row }) => (
      <span className="whitespace-nowrap">
        <Mono>{row.original.client}</Mono>
        {row.original.country && <span className="pl-1.5 text-muted-foreground">{row.original.country}</span>}
      </span>
    ),
  }),
  sample.accessor((s) => `${s.method} ${s.path}`, {
    id: 'request',
    header: 'Request',
    cell: ({ getValue }) => <Mono className="break-all">{getValue()}</Mono>,
  }),
]);

type Member = AdminOverview['members'][number];
const member = columns<Member>();
const memberColumns = member.columns([
  member.accessor('github', {
    header: 'GitHub',
    cell: ({ getValue }) => (
      <a
        href={`https://github.com/${getValue()}`}
        target="_blank"
        rel="noreferrer"
        className="rounded-sm font-medium outline-hidden hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
      >
        @{getValue()}
      </a>
    ),
  }),
  member.accessor('role', {
    header: 'Role',
    cell: ({ getValue }) => (
      <StatusPill tone={getValue() === 'admin' ? 'info' : 'muted'}>
        {getValue() === 'admin' ? 'Admin' : 'Member'}
      </StatusPill>
    ),
  }),
]);

function Members({ overview: o }: { overview: AdminOverview }) {
  return (
    <Panel
      flush
      title="Members"
      description={`${o.members.length} ${o.members.length === 1 ? 'member' : 'members'}`}
      footer={
        <span>
          Invite someone by adding their GitHub username to <Mono>members</Mono> in{' '}
          <Mono>platform.config.ts</Mono> and deploying the platform.
        </span>
      }
    >
      <DataTable
        columns={memberColumns}
        data={o.members}
        getRowId={(m) => m.github}
        initialSorting={[{ id: 'github', desc: false }]}
      />
    </Panel>
  );
}

function Limits({ limits: l }: { limits: AdminOverview['limits'] }) {
  const rows: Array<[string, string, string]> = [
    ['Apps per member', fmtNum(l.appsPerMember), 'apps a member can create'],
    ['Stages per app', fmtNum(l.stagesPerApp), 'prod and previews together'],
    ['Email recipients a day', l.emailsPerDay.toLocaleString('en'), 'per stage, UTC day'],
    ...(l.edgeRequestsPerMinute === undefined
      ? []
      : ([
          [
            'Edge requests per minute',
            l.edgeRequestsPerMinute.toLocaleString('en'),
            'per client per app, while the floor is on',
          ],
        ] as Array<[string, string, string]>)),
    ...(l.edgeFloorAt === undefined
      ? []
      : ([
          ['Edge floor turns on at', l.edgeFloorAt.toLocaleString('en'), 'requests a minute across the edge'],
        ] as Array<[string, string, string]>)),
  ];
  return (
    <Panel flush title="Limits" description="Set in platform.config.ts">
      <dl>
        {rows.map(([label, value, note]) => (
          <div
            key={label}
            className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 border-t px-5 py-3 first:border-t-0"
          >
            <dt className="text-sm">
              {label}
              <span className="block text-xs text-muted-foreground">{note}</span>
            </dt>
            <dd className="text-sm font-medium tabular">{value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
