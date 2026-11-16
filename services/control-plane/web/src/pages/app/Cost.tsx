import { useAtomValue } from '@effect/atom-react';
import { Atom } from 'effect/reactivity';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { Bars, SERIES_COLORS } from '../../components/charts.tsx';
import { Badge, Card, Loaded, Mono, Stat, Table } from '../../components/ui.tsx';
import { fmtNum, fmtUsd, fmtUsdCents, fmtUsdEstimate } from '../../format.ts';
import { useApp } from '../AppLayout.tsx';

// Cost Explorer refreshes daily and charges per request, so an hour-old answer is fresh enough.
const costAtom = Atom.family((app: string) =>
  fresh(ApiClient.query('observe', 'cost', { params: { app }, query: { days: 35 }, timeToLive }), {
    staleTime: '1 hour',
  }),
);

export function CostTab() {
  const { app } = useApp();
  const result = useAtomValue(costAtom(app));
  return (
    <Loaded result={result}>
      {(c) => {
        const last7 = c.days.slice(-7).reduce((a, d) => a + d.usd, 0);
        return (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Stat label="Month to date" value={fmtUsd(c.monthToDateUsd)} />
              <Stat label="Last 7 days" value={fmtUsd(last7)} />
              <Stat
                label="Daily average"
                value={fmtUsd(c.days.length ? c.days.reduce((a, d) => a + d.usd, 0) / c.days.length : 0)}
              />
            </div>
            <Card title="Daily cost (tagged platform:app)">
              <Bars
                data={c.days.map((d) => ({ ...d, ts: d.date }))}
                range="35d"
                format={(v) => fmtUsd(v)}
                series={[{ key: 'usd', label: 'USD', color: SERIES_COLORS.value }]}
              />
              <p className="pt-2 text-[11px] text-muted">
                From Cost Explorer, refreshed daily. Shared platform resources (router, tables, buckets)
                appear under Admin.
              </p>
            </Card>
            {c.compute && c.compute.length > 0 && (
              <Card title="Server compute, per month">
                <Table
                  head={['Stage', 'Runs in', 'web.compute', 'Request mode', 'Instance mode', 'Requests']}
                >
                  {c.compute.map((s) => (
                    <tr key={s.stage}>
                      <td>
                        <Mono>{s.stage}</Mono>
                      </td>
                      <td>
                        <Badge tone="info">{s.compute}</Badge>
                        {s.streak && (
                          <span className="ml-2 text-[11px] text-muted">
                            {s.streak.to} cheaper, day {s.streak.days} of 3
                          </span>
                        )}
                      </td>
                      <td>
                        <Mono>{s.setting}</Mono>
                      </td>
                      <td className="tabular-nums">
                        {s.estimate ? `≈ ${fmtUsdEstimate(s.estimate.request.monthlyUsd)}` : '—'}
                      </td>
                      <td className="tabular-nums">
                        {s.estimate ? `≈ ${fmtUsdEstimate(s.estimate.instance.monthlyUsd)}` : '—'}
                      </td>
                      <td className="tabular-nums">
                        {s.estimate ? fmtNum(s.estimate.requestsPerMonth) : '—'}
                      </td>
                    </tr>
                  ))}
                </Table>
                <p className="pt-2 text-[11px] text-muted">
                  Each mode priced daily from the stage’s recent traffic, before the free tier. On{' '}
                  <Mono>auto</Mono>, a stage moves to the other mode once it has cost 25% less three days
                  running.
                </p>
              </Card>
            )}
            {c.alwaysOn && c.alwaysOn.length > 0 && (
              <Card title="Always on">
                <Table head={['Stage', 'Service', 'Size', 'Compute', 'Public IPv4', '≈ Monthly']}>
                  {c.alwaysOn.map((a) => (
                    <tr key={`${a.stage}:${a.kind}:${a.name}`}>
                      <td>
                        <Mono>{a.stage}</Mono>
                      </td>
                      <td>
                        <Mono>{a.name}</Mono>
                      </td>
                      <td>{a.detail}</td>
                      <td className="tabular-nums">{fmtUsdCents(a.monthly.computeUsd)}</td>
                      <td className="tabular-nums">{fmtUsdCents(a.monthly.publicIpv4Usd)}</td>
                      <td className="font-medium tabular-nums">{fmtUsdCents(a.monthly.totalUsd)}</td>
                    </tr>
                  ))}
                </Table>
                <p className="pt-2 text-[11px] text-muted">
                  Estimated from each service’s size, running all month. Cost Explorer doesn’t attribute a
                  container’s public IPv4 address to the app; it is counted with the shared platform resources
                  under Admin.
                </p>
              </Card>
            )}
          </div>
        );
      }}
    </Loaded>
  );
}
