import { useAtomValue } from '@effect/atom-react';
import { Option } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { Bars, Lines, SERIES_COLORS, StackedArea } from '../../components/charts.tsx';
import { Card, Loaded, Stat } from '../../components/ui.tsx';
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
          </div>
        );
      }}
    </Loaded>
  );
}
