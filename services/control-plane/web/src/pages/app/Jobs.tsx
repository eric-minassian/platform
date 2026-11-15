import { useAtom, useAtomValue } from '@effect/atom-react';
import { Atom } from 'effect/reactivity';
import { useState } from 'react';
import { ApiClient, failure, fresh, succeeded, timeToLive } from '../../client.ts';
import { Badge, Button, Card, ErrorBox, Loaded, Mono, Table } from '../../components/ui.tsx';
import { fmtMs, fmtNum, relTime } from '../../format.ts';
import { type Scope, useApp } from '../AppLayout.tsx';

/** Reactivity key of an app's queue depths. */
const queuesChanged = (app: string) => [`queues:${app}`];

const jobsAtom = Atom.family(({ app, stage, range }: Scope & { app: string }) =>
  fresh(ApiClient.query('observe', 'jobs', { params: { app }, query: { stage, range }, timeToLive })),
);
const queuesAtom = Atom.family(({ app, stage }: { app: string; stage: string }) =>
  fresh(
    ApiClient.query('observe', 'queues', {
      params: { app },
      query: { stage },
      reactivityKeys: queuesChanged(app),
      timeToLive,
    }),
    { every: '15 seconds' },
  ),
);
const runCronAtom = ApiClient.mutation('manage', 'runCron');
const redriveAtom = ApiClient.mutation('manage', 'redrive');

export function JobsTab() {
  const { app, scope } = useApp();
  const jobs = useAtomValue(jobsAtom({ app, ...scope }));
  const queues = useAtomValue(queuesAtom({ app, stage: scope.stage }));
  const [runCron, run] = useAtom(runCronAtom);
  const [redrive, redriveQueue] = useAtom(redriveAtom);
  // The cron whose "Run now" was pressed last, to label it "Started".
  const [started, setStarted] = useState<string>();

  return (
    <div className="space-y-3">
      <Card title="Jobs">
        <Loaded result={jobs}>
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
          <ErrorBox error={failure(redrive)} />
          <Loaded result={queues}>
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
                        <Button
                          onClick={() =>
                            redriveQueue({
                              params: { app, name: q.name },
                              query: { stage: scope.stage },
                              reactivityKeys: queuesChanged(app),
                            })
                          }
                          disabled={redrive.waiting}
                        >
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
          <ErrorBox error={failure(runCron)} />
          <Loaded result={jobs}>
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
                      <Button
                        onClick={() => {
                          setStarted(c.name);
                          run({ params: { app, name: c.name }, query: { stage: scope.stage } });
                        }}
                        disabled={runCron.waiting}
                      >
                        {succeeded(runCron) && started === c.name ? 'Started' : 'Run now'}
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
