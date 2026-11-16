import { useAtomValue } from '@effect/atom-react';
import { Link } from 'react-router';
import { ApiClient, fresh, timeToLive } from '../client.ts';
import { Bars, SERIES_COLORS } from '../components/charts.tsx';
import { Badge, Card, Loaded, Mono, Stat, Table } from '../components/ui.tsx';
import { fmtDateTime, fmtNum, fmtPct, fmtUsd } from '../format.ts';

const overviewAtom = fresh(ApiClient.query('admin', 'overview', { timeToLive }));
const edgeAtom = fresh(ApiClient.query('admin', 'edge', { query: { range: '24h' }, timeToLive }), {
  every: '60 seconds',
});

export function AdminPage() {
  const result = useAtomValue(overviewAtom);
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Admin</h1>
      <Loaded result={result}>
        {(o) => (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Stat label="Apps" value={o.apps} />
              <Stat label="Live stages" value={o.stages} hint={`${o.previews} previews`} />
              <Stat
                label="Down"
                value={o.down.length}
                tone={o.down.length ? 'bad' : 'ok'}
                hint={o.down.join(', ') || 'all up'}
              />
              <Stat label="Account MTD" value={fmtUsd(o.cost.total?.monthToDateUsd)} />
              <Stat
                label="Shared platform MTD"
                value={fmtUsd(o.cost.shared?.monthToDateUsd)}
                hint="untagged resources"
              />
            </div>
            {o.cost.total && (
              <Card title="Account cost per day">
                <Bars
                  data={o.cost.total.days.map((d) => ({ ...d, ts: d.date }))}
                  range="35d"
                  format={(v) => fmtUsd(v)}
                  series={[{ key: 'usd', label: 'USD', color: SERIES_COLORS.value }]}
                />
              </Card>
            )}
            <EdgeFloorCard />
            <Card title="Members">
              <Table head={['GitHub', 'Role']}>
                {o.members.map((m) => (
                  <tr key={m.github}>
                    <td>
                      <a href={`https://github.com/${m.github}`} className="hover:underline">
                        @{m.github}
                      </a>
                    </td>
                    <td>
                      <Badge tone={m.role === 'admin' ? 'info' : 'muted'}>{m.role}</Badge>
                    </td>
                  </tr>
                ))}
              </Table>
              <p className="pt-2 text-[11px] text-muted">
                Invite someone by adding their GitHub username to <Mono>members</Mono> in{' '}
                <Mono>platform.config.ts</Mono> and deploying the platform. Limits: {o.limits.appsPerMember}{' '}
                apps per member, {o.limits.stagesPerApp} stages and {o.limits.servicesPerApp} services per
                app, {o.limits.emailsPerDay} email recipients a day per stage
                {o.limits.edgeRequestsPerMinute === undefined
                  ? '.'
                  : `, ${o.limits.edgeRequestsPerMinute} requests per client per app per minute at the edge.`}
              </p>
            </Card>
            <p className="text-[12px] text-muted">
              <Link to="/" className="text-accent hover:underline">
                ← All apps
              </Link>
            </p>
          </div>
        )}
      </Loaded>
    </div>
  );
}

/**
 * The edge's per-client request floor over the last 24 hours, for every app:
 * how many requests it blocked, when, and a sample of whom it blocked on
 * which host (WAF samples a share of requests, from the last three hours).
 */
function EdgeFloorCard() {
  const result = useAtomValue(edgeAtom);
  return (
    <Card title="Edge floor">
      <Loaded result={result}>
        {(e) =>
          e.enabled ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <Stat
                  label="Limit"
                  value={e.limit?.toLocaleString('en') ?? '—'}
                  hint="requests per client per app per minute"
                />
                <Stat
                  label="Blocked (24h)"
                  value={fmtNum(e.totals.blocked)}
                  tone={e.totals.blocked ? 'warn' : 'muted'}
                  hint={`${fmtPct(e.totals.blocked / (e.totals.blocked + e.totals.allowed || 1), 2)} of requests`}
                />
                <Stat label="Allowed (24h)" value={fmtNum(e.totals.allowed)} />
              </div>
              <Bars
                data={[...e.points]}
                range="24h"
                format={fmtNum}
                series={[{ key: 'blocked', label: 'blocked', color: SERIES_COLORS.s4xx }]}
              />
              <Table
                head={['Blocked at', 'Host', 'Client', 'Request']}
                empty="Nothing blocked in the last three hours."
              >
                {e.samples.slice(0, 20).map((s) => (
                  <tr key={`${s.at}${s.client}${s.path}`}>
                    <td className="whitespace-nowrap">{fmtDateTime(s.at)}</td>
                    <td>
                      <Mono>{s.host}</Mono>
                    </td>
                    <td>
                      <Mono>{s.client}</Mono>
                      {s.country && <span className="pl-1.5 text-muted">{s.country}</span>}
                    </td>
                    <td>
                      <Mono>{`${s.method} ${s.path}`}</Mono>
                    </td>
                  </tr>
                ))}
              </Table>
            </div>
          ) : (
            <p className="text-[12px] text-muted">
              Off. Set <Mono>limits.edgeRequestsPerMinute</Mono> in <Mono>platform.config.ts</Mono> and deploy
              the platform to block floods at the edge.
            </p>
          )
        }
      </Loaded>
    </Card>
  );
}
