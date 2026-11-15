import { useQuery } from '@tanstack/react-query';
import { api } from '../../api.ts';
import { Badge, Card, Loaded, Mono, Table } from '../../components/ui.tsx';
import { fmtMs, fmtNum, fmtPct } from '../../format.ts';
import { useApp } from '../AppLayout.tsx';

export function RequestsTab() {
  const { app, scope } = useApp();
  const q = useQuery({ queryKey: ['routes', app, scope], queryFn: () => api.routes(app, scope) });
  return (
    <Card title="Routes">
      <Loaded q={q}>
        {(routes) => (
          <Table
            head={['Method', 'Route', 'Requests', '4xx', '5xx', 'Error rate', 'p50', 'p95']}
            empty="No requests in this range."
          >
            {routes.map((r) => (
              <tr key={`${r.method} ${r.route}`}>
                <td>
                  <Badge>{r.method}</Badge>
                </td>
                <td>
                  <Mono>{r.route}</Mono>
                </td>
                <td className="tabular-nums">{fmtNum(r.req)}</td>
                <td className="tabular-nums text-warn">{r.s4xx || ''}</td>
                <td className="tabular-nums text-bad">{r.s5xx || ''}</td>
                <td className="tabular-nums">{fmtPct(r.req ? r.s5xx / r.req : 0)}</td>
                <td className="tabular-nums">{fmtMs(r.p50)}</td>
                <td className="tabular-nums">{fmtMs(r.p95)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Loaded>
    </Card>
  );
}
