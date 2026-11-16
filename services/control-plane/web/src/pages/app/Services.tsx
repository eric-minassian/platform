import { useAtom, useAtomValue } from '@effect/atom-react';
import { describeContainerSize, type ServiceInfo, type ServiceState } from '@ericminassian/platform-core';
import { Atom } from 'effect/reactivity';
import type { ReactNode } from 'react';
import { ApiClient, failure, fresh, timeToLive } from '../../client.ts';
import { Lines, SERIES_COLORS } from '../../components/charts.tsx';
import { Badge, Button, Card, Empty, ErrorBox, Loaded, Mono, type Tone } from '../../components/ui.tsx';
import { fmtDateTime, fmtNum, fmtUsdCents, relTime, shortId } from '../../format.ts';
import { type Scope, useApp } from '../AppLayout.tsx';

/** Reactivity key of an app's services: starting, stopping or restarting one refetches them. */
const servicesChanged = (app: string) => [`services:${app}`];

// A failing service stays failing until someone changes it, so only a start is followed closely.
const settling: ReadonlySet<ServiceState> = new Set(['starting']);

const servicesAtom = Atom.family(({ app, stage, range }: Scope & { app: string }) =>
  fresh(
    ApiClient.query('observe', 'services', {
      params: { app },
      query: { stage, range },
      reactivityKeys: servicesChanged(app),
      timeToLive,
    }),
    // Follows a rollout or replacement closely, then settles into a slower poll.
    { every: (d) => (d.services.some((s) => settling.has(s.state)) ? '5 seconds' : '30 seconds') },
  ),
);
const startAtom = ApiClient.mutation('manage', 'startService');
const stopAtom = ApiClient.mutation('manage', 'stopService');
const restartAtom = ApiClient.mutation('manage', 'restartService');

const stateTone: Record<ServiceState, Tone> = {
  running: 'ok',
  starting: 'info',
  failing: 'bad',
  stopped: 'muted',
};

/** ECS events shown per service; the API sends up to ten. */
const EVENTS_SHOWN = 5;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] tracking-wide whitespace-nowrap text-muted uppercase">{label}</dt>
      <dd className="mt-0.5 whitespace-nowrap tabular-nums">{children}</dd>
    </div>
  );
}

function ServiceCard({
  service: s,
  scope,
  actions,
}: {
  service: ServiceInfo;
  scope: Scope;
  actions: ReactNode;
}) {
  const events = s.events.slice(0, EVENTS_SHOWN);
  return (
    <Card
      title={
        <span className="flex items-center gap-2 tracking-normal normal-case">
          <Mono className="text-[12.5px] text-fg">{s.name}</Mono>
          <Badge tone={stateTone[s.state]}>{s.state}</Badge>
        </span>
      }
      actions={actions}
    >
      <div className="space-y-3 text-[12px]">
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          <Fact label="Tasks">
            {s.running}/{s.desired}
            {s.pending > 0 && <span className="text-muted"> · {s.pending} pending</span>}
          </Fact>
          <Fact label="Size">{describeContainerSize(s)}</Fact>
          <Fact label="Deployment">
            <Mono>{shortId(s.deployment)}</Mono>
          </Fact>
          <Fact label="Started">
            <span title={s.startedAt ? fmtDateTime(s.startedAt) : undefined}>{relTime(s.startedAt)}</span>
          </Fact>
          <Fact label="Stops">
            <span title={s.stopsAt ? fmtDateTime(s.stopsAt) : undefined}>
              {s.stopsAt ? relTime(s.stopsAt) : '—'}
            </span>
          </Fact>
          <Fact label={`Starts · ${scope.range}`}>{fmtNum(s.starts)}</Fact>
          <Fact label={`Failed runs · ${scope.range}`}>
            <span className={s.failedRuns > 0 ? 'text-bad' : undefined}>{fmtNum(s.failedRuns)}</span>
          </Fact>
          <Fact label="If always on">
            <span
              title={`${fmtUsdCents(s.monthly.computeUsd)} compute + ${fmtUsdCents(s.monthly.publicIpv4Usd)} public IPv4`}
            >
              ≈ {fmtUsdCents(s.monthly.totalUsd)}/month
            </span>
          </Fact>
        </dl>
        {s.lastStop && (
          <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
            <span className="text-[11px] tracking-wide text-muted uppercase">Last stop</span>
            <span title={fmtDateTime(s.lastStop.at)} className="text-muted">
              {relTime(s.lastStop.at)}
            </span>
            <span className="min-w-0 break-words">{s.lastStop.reason}</span>
            {s.lastStop.exitCode !== undefined && (
              <Mono className="text-muted">exit {s.lastStop.exitCode}</Mono>
            )}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[3fr_2fr]">
          <div>
            <div className="mb-1 text-[11px] tracking-wide text-muted uppercase">
              CPU and memory, % of size
            </div>
            <Lines
              data={[...s.points]}
              range={scope.range}
              height={160}
              format={(v) => `${Math.round(v)}%`}
              yDomain={[0, (max) => Math.max(max, 100)]}
              series={[
                { key: 'cpu', label: 'CPU', color: SERIES_COLORS.cpu },
                { key: 'memory', label: 'memory', color: SERIES_COLORS.memory },
              ]}
            />
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-[11px] tracking-wide text-muted uppercase">ECS events</div>
            {events.length === 0 ? (
              <div className="text-muted">No recent events.</div>
            ) : (
              <ul className="space-y-1 font-mono text-[11px]">
                {events.map((e) => (
                  <li key={`${e.at}${e.message}`} className="flex gap-2">
                    <span className="w-16 shrink-0 text-muted" title={fmtDateTime(e.at)}>
                      {relTime(e.at)}
                    </span>
                    <span className="min-w-0 break-words">{e.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function ServicesTab() {
  const { app, scope } = useApp();
  const result = useAtomValue(servicesAtom({ app, ...scope }));
  const [start, startService] = useAtom(startAtom);
  const [stop, stopService] = useAtom(stopAtom);
  const [restart, restartService] = useAtom(restartAtom);
  const busy = start.waiting || stop.waiting || restart.waiting;
  const request = (name: string) => ({
    params: { app, name },
    query: { stage: scope.stage },
    reactivityKeys: servicesChanged(app),
  });

  return (
    <div className="space-y-3">
      <ErrorBox error={failure(start) ?? failure(stop) ?? failure(restart)} />
      <Loaded result={result}>
        {(d) =>
          d.services.length === 0 ? (
            <Card title="Services">
              <Empty>No services.</Empty>
            </Card>
          ) : (
            d.services.map((s) => (
              <ServiceCard
                key={s.name}
                service={s}
                scope={scope}
                actions={
                  s.desired === 0 ? (
                    <Button onClick={() => startService({ ...request(s.name), payload: {} })} disabled={busy}>
                      Start
                    </Button>
                  ) : (
                    <>
                      <Button onClick={() => restartService(request(s.name))} disabled={busy}>
                        Restart
                      </Button>
                      <Button variant="danger" onClick={() => stopService(request(s.name))} disabled={busy}>
                        Stop
                      </Button>
                    </>
                  )
                }
              />
            ))
          )
        }
      </Loaded>
    </div>
  );
}
