import { useAtom, useAtomValue } from '@effect/atom-react';
import type { DeploymentStatus } from '@ericminassian/platform-core';
import { Atom } from 'effect/reactivity';
import { useState } from 'react';
import { ApiClient, failure, fresh, timeToLive } from '../../client.ts';
import {
  Badge,
  Button,
  Card,
  cx,
  Empty,
  ErrorBox,
  Loaded,
  Mono,
  statusTone,
  Table,
} from '../../components/ui.tsx';
import { duration, fmtDateTime, relTime, shortId } from '../../format.ts';
import { appChanged, useApp } from '../AppLayout.tsx';

/** Reactivity key of an app's deployment list, on every stage. */
const deploymentsChanged = (app: string) => [`deployments:${app}`];

const inProgress: readonly DeploymentStatus[] = ['queued', 'running', 'awaiting_upload'];

const deploymentsAtom = Atom.family(({ app, stage }: { app: string; stage: string }) =>
  fresh(
    ApiClient.query('deployments', 'list', {
      params: { app },
      query: { stage },
      reactivityKeys: deploymentsChanged(app),
      timeToLive,
    }),
    { every: '10 seconds' },
  ),
);
// Follows a deployment's event log while it runs.
const deploymentAtom = Atom.family((id: string) =>
  fresh(ApiClient.query('deployments', 'get', { params: { id }, timeToLive }), {
    every: (d) => (inProgress.includes(d.status) ? '2 seconds' : undefined),
  }),
);
const rollbackAtom = ApiClient.mutation('stages', 'rollback');
const destroyAtom = ApiClient.mutation('stages', 'destroy');

function Events({ id }: { id: string }) {
  return (
    <Loaded result={useAtomValue(deploymentAtom(id))}>
      {(d) => (
        <div className="space-y-2">
          {d.error && <ErrorBox error={d.error} />}
          <div className="max-h-80 overflow-y-auto rounded-md bg-panel-2 p-2 font-mono text-[11.5px]">
            {d.events.length === 0 ? (
              <span className="text-muted">No events yet.</span>
            ) : (
              d.events.map((e, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: append-only event log
                  key={i}
                  className={cx(e.level === 'error' && 'text-bad', e.level === 'warn' && 'text-warn')}
                >
                  <span className="text-muted">{new Date(e.ts).toLocaleTimeString()}</span> {e.msg}
                  {e.resource && <span className="text-muted"> · {e.resource}</span>}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </Loaded>
  );
}

export function DeploymentsTab() {
  const { app, scope, summary } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const result = useAtomValue(deploymentsAtom({ app, stage: scope.stage }));
  const stage = summary.stages.find((s) => s.stage === scope.stage);
  const [rollback, rollBackTo] = useAtom(rollbackAtom);
  const [destroy, destroyStage] = useAtom(destroyAtom);

  return (
    <div className="space-y-3">
      <Card title="Stages">
        <ErrorBox error={failure(destroy)} />
        <Table head={['Stage', 'Status', 'URL', 'Live deployment', 'Updated', '']}>
          {summary.stages.map((s) => (
            <tr key={s.stage}>
              <td>
                <Mono>{s.stage}</Mono>
              </td>
              <td>
                <Badge tone={statusTone(s.status)}>{s.status}</Badge>
              </td>
              <td>
                <a href={s.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  {s.host}
                </a>
              </td>
              <td>
                <Mono>{shortId(s.currentDeployment)}</Mono>
              </td>
              <td>{relTime(s.updatedAt)}</td>
              <td className="text-right">
                {s.preview && s.status !== 'destroying' && (
                  <Button
                    variant="danger"
                    onClick={() =>
                      destroyStage({
                        params: { app, stage: s.stage },
                        // Prod is only destroyed when the request names the app.
                        query: { confirm: s.stage === 'prod' ? app : undefined },
                        reactivityKeys: appChanged(app),
                      })
                    }
                    disabled={destroy.waiting}
                  >
                    Destroy
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title={`Deployments · ${scope.stage}`}>
        <ErrorBox error={failure(rollback)} />
        <Loaded result={result}>
          {(deps) =>
            deps.length === 0 ? (
              <Empty>
                No deployments to this stage yet. Push to main, open a PR, or run <Mono>plat deploy</Mono>.
              </Empty>
            ) : (
              <Table head={['Deployment', 'Status', 'Commit', 'Actor', 'Created', 'Took', '']}>
                {deps.flatMap((d) => {
                  const live = stage?.currentDeployment === d.id;
                  const rows = [
                    <tr
                      key={d.id}
                      className="cursor-pointer hover:bg-panel-2"
                      onClick={() => setOpen(open === d.id ? null : d.id)}
                    >
                      <td>
                        <Mono>{shortId(d.id)}</Mono> {live && <Badge tone="ok">live</Badge>}
                      </td>
                      <td>
                        <Badge tone={statusTone(d.status)}>{d.status}</Badge>
                      </td>
                      <td className="max-w-xs truncate">
                        {d.commit && <Mono>{d.commit.slice(0, 7)}</Mono>}{' '}
                        <span className="text-muted">{d.message}</span>
                      </td>
                      <td>{d.actor}</td>
                      <td title={fmtDateTime(d.createdAt)}>{relTime(d.createdAt)}</td>
                      <td>{duration(d.startedAt, d.finishedAt)}</td>
                      <td className="text-right">
                        {!live && d.status === 'succeeded' && (
                          <Button
                            onClick={(e) => {
                              e.stopPropagation();
                              rollBackTo({
                                params: { app, stage: scope.stage },
                                payload: { deploymentId: d.id },
                                reactivityKeys: [...deploymentsChanged(app), ...appChanged(app)],
                              });
                            }}
                            disabled={rollback.waiting}
                          >
                            Roll back to this
                          </Button>
                        )}
                      </td>
                    </tr>,
                  ];
                  if (open === d.id) {
                    rows.push(
                      <tr key={`${d.id}-events`}>
                        <td colSpan={7}>
                          <Events id={d.id} />
                        </td>
                      </tr>,
                    );
                  }
                  return rows;
                })}
              </Table>
            )
          }
        </Loaded>
      </Card>
    </div>
  );
}
