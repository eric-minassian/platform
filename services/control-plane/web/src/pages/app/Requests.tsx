import { useAtomValue } from '@effect/atom-react';
import { Atom } from 'effect/reactivity';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { Badge, Card, Loaded, Mono, Table } from '../../components/ui.tsx';
import { fmtMs, fmtNum, fmtPct } from '../../format.ts';
import { type Scope, useApp } from '../AppLayout.tsx';

const routesAtom = Atom.family(({ app, stage, range }: Scope & { app: string }) =>
  fresh(ApiClient.query('observe', 'routes', { params: { app }, query: { stage, range }, timeToLive })),
);

export function RequestsTab() {
  const { app, scope } = useApp();
  const result = useAtomValue(routesAtom({ app, ...scope }));
  return (
    <Card title="Routes">
      <Loaded result={result}>
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
                <td className="text-warn tabular-nums">{r.s4xx || ''}</td>
                <td className="text-bad tabular-nums">{r.s5xx || ''}</td>
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
