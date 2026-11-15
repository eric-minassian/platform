import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../api.ts';
import { Bars, SERIES_COLORS } from '../components/charts.tsx';
import { Badge, Card, Loaded, Mono, Stat, Table } from '../components/ui.tsx';
import { fmtUsd } from '../format.ts';

export function AdminPage() {
  const q = useQuery({ queryKey: ['admin'], queryFn: api.adminOverview });
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Admin</h1>
      <Loaded q={q}>
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
                apps per member, {o.limits.stagesPerApp} stages per app.
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
