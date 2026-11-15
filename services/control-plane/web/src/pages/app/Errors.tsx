import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { ErrorGroup, ErrorStatus } from '@ericminassian/platform-core';
import { Option } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { Link, useSearchParams } from 'react-router';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import {
  Badge,
  Button,
  Card,
  cx,
  Empty,
  Loaded,
  Mono,
  Select,
  statusTone,
  Table,
} from '../../components/ui.tsx';
import { fmtDateTime, fmtNum, relTime, shortId } from '../../format.ts';
import { useApp } from '../AppLayout.tsx';

const STATUSES: readonly string[] = ['open', 'resolved', 'ignored'] satisfies ErrorStatus[];
const isStatus = (s: string): s is ErrorStatus => STATUSES.includes(s);

/** Reactivity key of an app's error groups, on every stage and status. */
const errorsChanged = (app: string) => [`errors:${app}`];

const errorsAtom = Atom.family(({ app, stage, status }: { app: string; stage: string; status: string }) =>
  fresh(
    ApiClient.query('observe', 'errors', {
      params: { app },
      query: { stage, status: isStatus(status) ? status : undefined },
      reactivityKeys: errorsChanged(app),
      timeToLive,
    }),
    { every: '30 seconds' },
  ),
);
const updateError = ApiClient.mutation('observe', 'updateError');

function Detail({ g, onStatus }: { g: ErrorGroup; onStatus: (s: ErrorGroup['status']) => void }) {
  const { app, search } = useApp();
  return (
    <Card
      title={`${g.name}`}
      actions={
        <>
          {g.status !== 'resolved' && <Button onClick={() => onStatus('resolved')}>Resolve</Button>}
          {g.status !== 'ignored' && (
            <Button variant="ghost" onClick={() => onStatus('ignored')}>
              Ignore
            </Button>
          )}
          {g.status !== 'open' && (
            <Button variant="ghost" onClick={() => onStatus('open')}>
              Reopen
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[13px] break-words">{g.message}</p>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted">
          <span>{fmtNum(g.count)} occurrences</span>
          <span>first {fmtDateTime(g.firstSeen)}</span>
          <span>last {fmtDateTime(g.lastSeen)}</span>
          <span>source {g.source}</span>
          {g.sample.route && (
            <span>
              route <Mono>{g.sample.route}</Mono>
            </span>
          )}
          {g.sample.job && (
            <span>
              job <Mono>{g.sample.job}</Mono>
            </span>
          )}
          {g.sample.rev && (
            <span>
              deployment <Mono>{shortId(g.sample.rev)}</Mono>
            </span>
          )}
          {g.sample.trace && (
            <Link
              to={`/apps/${app}/traces/${g.sample.trace}${search}`}
              className="text-accent hover:underline"
            >
              view trace
            </Link>
          )}
        </div>
        <pre className="max-h-96 overflow-auto rounded-md bg-panel-2 p-3 font-mono text-[11.5px] leading-relaxed">
          {g.sample.stack ?? '(no stack trace)'}
        </pre>
      </div>
    </Card>
  );
}

export function ErrorsTab() {
  const { app, scope } = useApp();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'open';
  const fp = params.get('fp');
  const result = useAtomValue(errorsAtom({ app, stage: scope.stage, status }));
  // Nothing shows the outcome: the list refetches when it succeeds.
  const setStatus = useAtomSet(updateError);
  const select = (next: string | null) =>
    setParams((p) => {
      if (next) p.set('fp', next);
      else p.delete('fp');
      return p;
    });

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card
        title="Error groups"
        actions={
          <Select
            value={status}
            onChange={(v) =>
              setParams((p) => {
                p.set('status', v);
                return p;
              })
            }
            options={['open', 'resolved', 'ignored', 'all'].map((s) => ({ value: s, label: s }))}
          />
        }
      >
        <Loaded result={result}>
          {(groups) => (
            <Table head={['Error', 'Status', 'Count', 'Last seen', 'First seen']} empty="No errors. Nice.">
              {groups.map((g) => (
                <tr
                  key={g.fingerprint}
                  onClick={() => select(g.fingerprint)}
                  className={cx('cursor-pointer hover:bg-panel-2', fp === g.fingerprint && 'bg-panel-2')}
                >
                  <td className="max-w-md">
                    <div className="truncate font-medium">{g.name}</div>
                    <div className="truncate text-muted">{g.message}</div>
                  </td>
                  <td>
                    <Badge tone={statusTone(g.status)}>{g.status}</Badge>
                  </td>
                  <td className="tabular-nums">{fmtNum(g.count)}</td>
                  <td className="whitespace-nowrap">{relTime(g.lastSeen)}</td>
                  <td className="whitespace-nowrap text-muted">{relTime(g.firstSeen)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Loaded>
      </Card>
      <div>
        {(() => {
          const g = Option.getOrUndefined(AsyncResult.value(result))?.find((x) => x.fingerprint === fp);
          if (!g) {
            return (
              <Card>
                <Empty>Select an error group to see its stack trace and trace.</Empty>
              </Card>
            );
          }
          return (
            <Detail
              g={g}
              onStatus={(s) =>
                setStatus({
                  params: { app, fingerprint: g.fingerprint },
                  query: { stage: scope.stage },
                  payload: { status: s },
                  reactivityKeys: errorsChanged(app),
                })
              }
            />
          );
        })()}
      </div>
    </div>
  );
}
