/**
 * An app stage's realtime channels (AppSync Events): who may subscribe,
 * which channels it declares, and publishes, events, subscribes and errors
 * over the page's window. AppSync counts deliveries and connections only
 * for the whole Event API, so there's no per-app figure for either.
 */
import { useAtomValue } from '@effect/atom-react';
import type { MetricsView, RealtimeStatsResponse } from '@ericminassian/platform-core';
import type { ReactElement } from 'react';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { ChartMenu } from '../../components/metrics/chart-panel.tsx';
import { EmptyState, Loaded, Loading, Mono, PageHeader, Panel, Stat } from '../../components/page.tsx';
import { type PointSeries, PointsChart } from '../../components/points/points-chart.tsx';
import { family } from '../../data/atoms.ts';
import { fmtNum } from '../../format.ts';
import { useAutoRefresh, useStage, useSticky, useTime } from '../../lib/hooks.ts';
import { apiTime, type TimeSearch } from '../../lib/time.ts';
import { appRoute } from '../../router.tsx';

// CloudWatch has AppSync's counts a few minutes late; a minute's poll keeps up.
const realtimeAtom = family((k: { app: string; stage: string; time: TimeSearch }) =>
  fresh(
    ApiClient.query('observe', 'realtime', {
      params: { app: k.app },
      query: { stage: k.stage, ...apiTime(k.time) },
      timeToLive,
    }),
    { every: '60 seconds' },
  ),
);

const PUBLISHED: readonly PointSeries<'events' | 'publishes'>[] = [
  { key: 'events', label: 'Events', color: 'var(--chart-1)' },
  { key: 'publishes', label: 'Publish requests', color: 'var(--chart-7)' },
];
const SUBSCRIBED: readonly PointSeries<'subscribes' | 'errors'>[] = [
  { key: 'subscribes', label: 'Subscribes', color: 'var(--chart-3)' },
  { key: 'errors', label: 'Errors', color: 'var(--s5xx)' },
];

/** The same lines as series queries, for the charts' menus (Metrics, dashboards). */
const measureView = (measures: ReadonlyArray<{ measure: string; label: string }>): MetricsView => ({
  kind: 'metrics',
  queries: measures.map((m, i) => ({
    id: String.fromCharCode(97 + i),
    metric: 'realtime',
    stat: 'sum',
    filter: { measure: m.measure },
    label: m.label,
  })),
  chart: 'line',
});
const PUBLISHED_VIEW = measureView([
  { measure: 'events', label: 'Events' },
  { measure: 'publishes', label: 'Publish requests' },
]);
const SUBSCRIBED_VIEW = measureView([
  { measure: 'subscribes', label: 'Subscribes' },
  { measure: 'errors', label: 'Errors' },
]);

export function RealtimePage(): ReactElement {
  const { app } = appRoute.useParams();
  const stage = useStage();
  const time = useTime();
  const atom = realtimeAtom({ app, stage, time: time.search });
  useAutoRefresh(atom, time.search.from === undefined);
  const result = useSticky(useAtomValue(atom));
  return (
    <>
      <PageHeader title="Realtime" description={`AppSync Events activity of ${stage}'s channels.`} />
      <Loaded result={result} loading={<Loading />}>
        {(r) =>
          r.enabled ? (
            <RealtimeStage app={app} stage={stage} stats={r} />
          ) : (
            <Panel>
              <EmptyState title={`No realtime channels on ${stage}`}>
                Declare <Mono>realtime</Mono> in <Mono>plat.config.ts</Mono> to publish to subscribers.
              </EmptyState>
            </Panel>
          )
        }
      </Loaded>
    </>
  );
}

function RealtimeStage({
  app,
  stage,
  stats: r,
}: {
  app: string;
  stage: string;
  stats: RealtimeStatsResponse;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Channels"
          value={
            r.channels.length ? (
              <span className="flex flex-wrap gap-x-3 font-mono text-lg font-medium">
                {r.channels.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </span>
            ) : (
              '–'
            )
          }
          note={
            r.subscribe === 'signed-in' ? 'users signed in to the app can subscribe' : 'anyone can subscribe'
          }
        />
        <Stat
          label="Events published"
          value={fmtNum(r.totals.events)}
          note={`${fmtNum(r.totals.publishes)} publish requests`}
        />
        <Stat label="Subscribes" value={fmtNum(r.totals.subscribes)} note="successful" />
        <Stat
          label="Errors"
          value={fmtNum(r.totals.errors)}
          tone={r.totals.errors > 0 ? 'warn' : undefined}
          note="publishes and subscribes refused or failed"
        />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel
          title="Published"
          description="Events, and the requests that carried them (up to 5 each)"
          actions={
            <ChartMenu app={app} stage={stage} title="Realtime events published" view={PUBLISHED_VIEW} />
          }
        >
          <PointsChart
            points={r.points}
            res={r.res}
            series={PUBLISHED}
            kind="line"
            format={fmtNum}
            ariaLabel="Realtime events and publish requests"
          />
        </Panel>
        <Panel
          title="Subscribes and errors"
          description="Subscriptions accepted, and publishes or subscribes refused"
          actions={
            <ChartMenu
              app={app}
              stage={stage}
              title="Realtime subscribes and errors"
              view={SUBSCRIBED_VIEW}
            />
          }
        >
          <PointsChart
            points={r.points}
            res={r.res}
            series={SUBSCRIBED}
            kind="line"
            format={fmtNum}
            ariaLabel="Realtime subscribes and errors"
          />
        </Panel>
      </div>
      <p className="text-xs text-muted-foreground">
        AppSync reports deliveries to subscribers and open connections only for the whole platform, so neither
        is shown per app.
      </p>
    </div>
  );
}
