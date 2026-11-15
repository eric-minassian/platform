import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api.ts';
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
import { useApp } from '../AppLayout.tsx';

function Events({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['deployment', id],
    queryFn: () => api.deployment(id),
    refetchInterval: (query) =>
      query.state.data && ['queued', 'running', 'awaiting_upload'].includes(query.state.data.status)
        ? 2_000
        : false,
  });
  return (
    <Loaded q={q}>
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
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['deployments', app, scope.stage],
    queryFn: () => api.deployments(app, scope.stage),
    refetchInterval: 10_000,
  });
  const stage = summary.stages.find((s) => s.stage === scope.stage);
  const rollback = useMutation({
    mutationFn: (id: string) => api.rollback(app, scope.stage, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deployments', app] });
      qc.invalidateQueries({ queryKey: ['app', app] });
    },
  });
  const destroy = useMutation({
    mutationFn: (s: string) => api.destroyStage(app, s, s === 'prod' ? app : undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app', app] }),
  });

  return (
    <div className="space-y-3">
      <Card title="Stages">
        <ErrorBox error={destroy.error} />
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
                    onClick={() => destroy.mutate(s.stage)}
                    disabled={destroy.isPending}
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
        <ErrorBox error={rollback.error} />
        <Loaded q={q}>
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
                              rollback.mutate(d.id);
                            }}
                            disabled={rollback.isPending}
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
