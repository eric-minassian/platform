import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api.ts';
import { Badge, Button, Card, ErrorBox, Loaded, Mono, Table } from '../../components/ui.tsx';
import { fmtMs, fmtNum, relTime } from '../../format.ts';
import { useApp } from '../AppLayout.tsx';

export function JobsTab() {
  const { app, scope } = useApp();
  const qc = useQueryClient();
  const jobs = useQuery({ queryKey: ['jobs', app, scope], queryFn: () => api.jobs(app, scope) });
  const queues = useQuery({
    queryKey: ['queues', app, scope.stage],
    queryFn: () => api.queues(app, scope.stage),
    refetchInterval: 15_000,
  });
  const runCron = useMutation({ mutationFn: (name: string) => api.runCron(app, scope.stage, name) });
  const redrive = useMutation({
    mutationFn: (name: string) => api.redrive(app, scope.stage, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queues', app] }),
  });

  return (
    <div className="space-y-3">
      <Card title="Jobs">
        <Loaded q={jobs}>
          {(d) => (
            <Table
              head={['Kind', 'Name', 'OK', 'Failed', 'p95', 'Last run']}
              empty="No queues, event subscriptions or crons."
            >
              {d.jobs.map((j) => (
                <tr key={`${j.kind}:${j.name}`}>
                  <td>
                    <Badge>{j.kind}</Badge>
                  </td>
                  <td>
                    <Mono>{j.name}</Mono>
                  </td>
                  <td className="tabular-nums">{fmtNum(j.ok)}</td>
                  <td className="tabular-nums text-bad">{j.error || ''}</td>
                  <td className="tabular-nums">{fmtMs(j.p95)}</td>
                  <td>{relTime(j.lastRun)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Loaded>
      </Card>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="Queues">
          <ErrorBox error={redrive.error} />
          <Loaded q={queues}>
            {(qs) => (
              <Table
                head={['Queue', 'Waiting', 'In flight', 'Dead letters', '']}
                empty="No queues on this stage."
              >
                {qs.map((q) => (
                  <tr key={q.name}>
                    <td>
                      <Mono>{q.name}</Mono>
                    </td>
                    <td className="tabular-nums">{fmtNum(q.visible)}</td>
                    <td className="tabular-nums">{fmtNum(q.inFlight)}</td>
                    <td className={q.deadLetter ? 'tabular-nums font-medium text-bad' : 'tabular-nums'}>
                      {fmtNum(q.deadLetter)}
                    </td>
                    <td className="text-right">
                      {q.deadLetter > 0 && (
                        <Button onClick={() => redrive.mutate(q.name)} disabled={redrive.isPending}>
                          Redrive
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Loaded>
        </Card>
        <Card title="Crons">
          <ErrorBox error={runCron.error} />
          <Loaded q={jobs}>
            {(d) => (
              <Table head={['Cron', 'Schedule (UTC)', '']} empty="No crons on this stage.">
                {d.crons.map((c) => (
                  <tr key={c.name}>
                    <td>
                      <Mono>{c.name}</Mono>
                    </td>
                    <td>
                      <Mono>{c.schedule}</Mono>
                    </td>
                    <td className="text-right">
                      <Button onClick={() => runCron.mutate(c.name)} disabled={runCron.isPending}>
                        {runCron.isSuccess && runCron.variables === c.name ? 'Started' : 'Run now'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Loaded>
        </Card>
      </div>
    </div>
  );
}
