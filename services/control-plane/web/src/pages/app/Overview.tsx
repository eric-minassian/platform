import { useAtomValue } from '@effect/atom-react';
import { Option } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { Bars, Lines, SERIES_COLORS, StackedArea } from '../../components/charts.tsx';
import { Card, Loaded, Mono, Stat, Table } from '../../components/ui.tsx';
import { fmtMs, fmtNum, fmtPct } from '../../format.ts';
import { type Scope, useApp } from '../AppLayout.tsx';

const metricsAtom = Atom.family(({ app, stage, range }: Scope & { app: string }) =>
  fresh(ApiClient.query('observe', 'metrics', { params: { app }, query: { stage, range }, timeToLive }), {
    every: '30 seconds',
  }),
);
const uptimeAtom = Atom.family(({ app, stage, range }: Scope & { app: string }) =>
  fresh(ApiClient.query('observe', 'uptime', { params: { app }, query: { stage, range }, timeToLive })),
);
const realtimeAtom = Atom.family(({ app, stage, range }: Scope & { app: string }) =>
  fresh(ApiClient.query('observe', 'realtime', { params: { app }, query: { stage, range }, timeToLive }), {
    every: '60 seconds',
  }),
);
const limitsAtom = Atom.family(({ app, stage, range }: Scope & { app: string }) =>
  fresh(ApiClient.query('observe', 'limits', { params: { app }, query: { stage, range }, timeToLive }), {
    every: '60 seconds',
  }),
);

export function OverviewTab() {
  const { app, scope } = useApp();
  const metrics = useAtomValue(metricsAtom({ app, ...scope }));
  const uptime = useAtomValue(uptimeAtom({ app, ...scope }));

  return (
    <Loaded result={metrics}>
      {(m) => {
        const total = m.points.reduce((a, p) => a + p.req, 0);
        const errors = m.points.reduce((a, p) => a + p.s5xx, 0);
        const cold = m.points.reduce((a, p) => a + p.cold, 0);
        const p95s = m.points.map((p) => p.p95).filter((v): v is number => v !== null);
        const checks = Option.getOrElse(AsyncResult.value(uptime), () => []);
        const up = checks.length ? checks.filter((c) => c.ok).length / checks.length : null;
        const data = m.points.map((p) => ({ ...p, errRate: p.req ? p.s5xx / p.req : 0 }));
        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Stat label="Requests" value={fmtNum(total)} hint={`${scope.range} · ${m.res} buckets`} />
              <Stat
                label="5xx rate"
                value={fmtPct(total ? errors / total : 0)}
                tone={errors / (total || 1) > 0.01 ? 'bad' : 'ok'}
              />
              <Stat label="p95 (max)" value={fmtMs(p95s.length ? Math.max(...p95s) : null)} />
              <Stat label="Cold starts" value={fmtNum(cold)} />
              <Stat
                label="Uptime"
                value={fmtPct(up, 2)}
                tone={up === null ? 'muted' : up > 0.999 ? 'ok' : 'warn'}
                hint={checks.length ? `${checks.length} checks` : 'prod only'}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Card title="Requests by status">
                <StackedArea
                  data={data}
                  range={scope.range}
                  format={fmtNum}
                  series={[
                    { key: 's2xx', label: '2xx', color: SERIES_COLORS.s2xx },
                    { key: 's3xx', label: '3xx', color: SERIES_COLORS.s3xx },
                    { key: 's4xx', label: '4xx', color: SERIES_COLORS.s4xx },
                    { key: 's5xx', label: '5xx', color: SERIES_COLORS.s5xx },
                  ]}
                />
              </Card>
              <Card title="Latency">
                <Lines
                  data={data}
                  range={scope.range}
                  format={fmtMs}
                  series={[
                    { key: 'p50', label: 'p50', color: SERIES_COLORS.p50 },
                    { key: 'p95', label: 'p95', color: SERIES_COLORS.p95 },
                    { key: 'p99', label: 'p99', color: SERIES_COLORS.p99 },
                  ]}
                />
              </Card>
              <Card title="Error rate (5xx)">
                <Lines
                  data={data}
                  range={scope.range}
                  format={(v) => fmtPct(v)}
                  yDomain={[0, (max) => Math.max(max, 0.05)]}
                  series={[{ key: 'errRate', label: '5xx rate', color: SERIES_COLORS.s5xx }]}
                />
              </Card>
              <Card title="Cold starts">
                <Bars
                  data={data}
                  range={scope.range}
                  format={fmtNum}
                  series={[{ key: 'cold', label: 'cold starts', color: SERIES_COLORS.value }]}
                />
              </Card>
            </div>
            <RealtimeSection app={app} scope={scope} />
            <RateLimitsSection app={app} scope={scope} />
          </div>
        );
      }}
    </Loaded>
  );
}

/**
 * The stage's AppSync Events activity, shown only when its live deployment
 * declares `realtime`. AppSync counts deliveries and connections only for the
 * whole platform, so there's no per-app figure for either.
 */
function RealtimeSection({ app, scope }: { app: string; scope: Scope }) {
  const result = useAtomValue(realtimeAtom({ app, ...scope }));
  const r = Option.getOrUndefined(AsyncResult.value(result));
  if (!r?.enabled) return null;
  return (
    <Card
      title="Realtime"
      actions={
        <span className="text-[11px] text-muted">
          {r.subscribe === 'signed-in' ? 'signed-in' : 'public'} · {r.channels.join(', ')}
        </span>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Stat
            label="Events published"
            value={fmtNum(r.totals.events)}
            hint={`${fmtNum(r.totals.publishes)} publish requests`}
          />
          <Stat label="Subscribes" value={fmtNum(r.totals.subscribes)} />
          <Stat
            label="Errors"
            value={fmtNum(r.totals.errors)}
            tone={r.totals.errors > 0 ? 'warn' : 'muted'}
            hint="refused or failed"
          />
        </div>
        <Lines
          data={[...r.points]}
          range={scope.range}
          format={fmtNum}
          series={[
            { key: 'events', label: 'events', color: SERIES_COLORS.value },
            { key: 'subscribes', label: 'subscribes', color: SERIES_COLORS.p50 },
            { key: 'errors', label: 'errors', color: SERIES_COLORS.s5xx },
          ]}
        />
      </div>
    </Card>
  );
}

/**
 * Checks of the app's `RateLimits` in the range, shown only when there were
 * any: allowed and denied per limit, and all of them over time. Denials are a
 * 4xx answer, so they take the 4xx color, beside allowed checks in the 2xx one.
 */
function RateLimitsSection({ app, scope }: { app: string; scope: Scope }) {
  const result = useAtomValue(limitsAtom({ app, ...scope }));
  const r = Option.getOrUndefined(AsyncResult.value(result));
  if (!r?.limits.length) return null;
  // Every limit has one point per bucket of the same range, so they sum by position.
  const data = r.limits[0]!.points.map((p, i) => ({
    ts: p.ts,
    allowed: r.limits.reduce((a, l) => a + (l.points[i]?.allowed ?? 0), 0),
    denied: r.limits.reduce((a, l) => a + (l.points[i]?.denied ?? 0), 0),
  }));
  return (
    <Card title="Rate limits" actions={<span className="text-[11px] text-muted">{r.res} buckets</span>}>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Table head={['Limit', 'Allowed', 'Denied', 'Denied %']}>
          {r.limits.map((l) => (
            <tr key={l.name}>
              <td>
                <Mono>{l.name}</Mono>
              </td>
              <td className="tabular-nums">{fmtNum(l.allowed)}</td>
              <td className={l.denied ? 'font-medium text-warn tabular-nums' : 'tabular-nums'}>
                {fmtNum(l.denied)}
              </td>
              <td className="tabular-nums">{fmtPct(l.denied / (l.allowed + l.denied))}</td>
            </tr>
          ))}
        </Table>
        <StackedArea
          data={data}
          range={scope.range}
          format={fmtNum}
          series={[
            { key: 'allowed', label: 'allowed', color: SERIES_COLORS.s2xx },
            { key: 'denied', label: 'denied', color: SERIES_COLORS.s4xx },
          ]}
        />
      </div>
    </Card>
  );
}
