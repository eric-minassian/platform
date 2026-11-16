import { useAtom, useAtomValue } from '@effect/atom-react';
import type { DeadLetterItem } from '@ericminassian/platform-core';
import { Option } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { useState } from 'react';
import { ApiClient, failure, fresh, succeeded, timeToLive } from '../../client.ts';
import { Badge, Button, Card, ErrorBox, Loaded, Mono, Table } from '../../components/ui.tsx';
import { fmtMs, fmtNum, relTime } from '../../format.ts';
import { type Scope, useApp } from '../AppLayout.tsx';

/** Reactivity key of an app's scheduled jobs and dead letters. */
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
const deadLettersAtom = Atom.family(({ app, stage }: { app: string; stage: string }) =>
  fresh(
    ApiClient.query('observe', 'deadLetters', {
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
const discardAtom = ApiClient.mutation('manage', 'discard');

export function JobsTab() {
  const { app, scope } = useApp();
  const jobs = useAtomValue(jobsAtom({ app, ...scope }));
  const queues = useAtomValue(queuesAtom({ app, stage: scope.stage }));
  const [runCron, run] = useAtom(runCronAtom);
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
                  <td className="text-bad tabular-nums">{j.error || ''}</td>
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
          <Loaded result={queues}>
            {(qs) => (
              <Table head={['Queue', 'Scheduled', 'Dead letters']} empty="No queues on this stage.">
                {qs.map((q) => (
                  <tr key={q.name}>
                    <td>
                      <Mono>{q.name}</Mono>
                    </td>
                    <td className="tabular-nums" title="Retries and delayed sends waiting for their time">
                      {fmtNum(q.scheduled)}
                    </td>
                    <td className={q.deadLetter ? 'font-medium text-bad tabular-nums' : 'tabular-nums'}>
                      {fmtNum(q.deadLetter)}
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
      <DeadLetters app={app} stage={scope.stage} />
    </div>
  );
}

/**
 * Jobs that failed every attempt, from the stage's dead-letter queue. Redrive
 * runs them again from their first attempt; discarding everything takes a
 * second click.
 */
function DeadLetters({ app, stage }: { app: string; stage: string }) {
  const letters = useAtomValue(deadLettersAtom({ app, stage }));
  const [redrive, runRedrive] = useAtom(redriveAtom);
  const [discard, runDiscard] = useAtom(discardAtom);
  const [confirmAll, setConfirmAll] = useState(false);
  const busy = redrive.waiting || discard.waiting;
  const total = Option.match(AsyncResult.value(letters), { onNone: () => 0, onSome: (d) => d.total });
  const act = (run: typeof runRedrive, ids?: readonly string[]) =>
    run({
      params: { app },
      query: { stage },
      payload: ids ? { ids } : {},
      reactivityKeys: queuesChanged(app),
    });

  return (
    <Card
      title="Dead letters"
      actions={
        total > 0 && (
          <>
            <Button onClick={() => act(runRedrive)} disabled={busy}>
              Redrive all
            </Button>
            {confirmAll ? (
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmAll(false);
                  act(runDiscard);
                }}
                disabled={busy}
              >
                Discard {fmtNum(total)}
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmAll(true)} disabled={busy}>
                Discard all
              </Button>
            )}
          </>
        )
      }
    >
      <ErrorBox error={failure(redrive) ?? failure(discard)} />
      <Loaded result={letters}>
        {(d) => (
          <>
            <Table head={['Job', 'Error', 'Attempts', 'Failed', '']} empty="No dead letters.">
              {d.items.map((l) => (
                <DeadLetterRow
                  key={l.id}
                  letter={l}
                  busy={busy}
                  onRedrive={() => act(runRedrive, [l.id])}
                  onDiscard={() => act(runDiscard, [l.id])}
                />
              ))}
            </Table>
            {d.total > d.items.length && (
              <p className="px-2 pt-2 text-[12px] text-muted">
                {fmtNum(d.items.length)} of about {fmtNum(d.total)} shown.
              </p>
            )}
          </>
        )}
      </Loaded>
    </Card>
  );
}

function DeadLetterRow({
  letter: l,
  busy,
  onRedrive,
  onDiscard,
}: {
  letter: DeadLetterItem;
  busy: boolean;
  onRedrive: () => void;
  onDiscard: () => void;
}) {
  return (
    <tr>
      <td className="whitespace-nowrap">
        {l.kind === 'unknown' ? (
          <Badge>unknown</Badge>
        ) : (
          <>
            <Badge>{l.kind}</Badge> <Mono>{l.name}</Mono>
          </>
        )}
      </td>
      <td className="max-w-[28rem]">
        <div className="truncate" title={l.error.message}>
          <span className="text-bad">{l.error.name}</span> {l.error.message}
        </div>
        {l.preview && (
          <div className="truncate text-muted" title={l.preview}>
            <Mono>{l.preview}</Mono>
          </div>
        )}
      </td>
      <td className="tabular-nums">{l.attempts ?? '—'}</td>
      <td className="whitespace-nowrap">{relTime(l.failedAt ?? undefined)}</td>
      <td className="text-right whitespace-nowrap">
        {l.kind !== 'unknown' && (
          <Button onClick={onRedrive} disabled={busy}>
            Redrive
          </Button>
        )}{' '}
        <Button variant="ghost" onClick={onDiscard} disabled={busy}>
          Discard
        </Button>
      </td>
    </tr>
  );
}
