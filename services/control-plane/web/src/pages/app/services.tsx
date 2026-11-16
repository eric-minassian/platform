/**
 * An app stage's long-running services: each one's state and size, its CPU
 * and memory over the page's window, how often it started and how many
 * runs failed, what ECS said lately and why its last task stopped, and what
 * it costs a month if it runs all month. Each can be restarted, stopped, or
 * started (for a number of minutes, or until stopped).
 */
import { useAtom, useAtomValue } from '@effect/atom-react';
import {
  describeContainerSize,
  type MetricsView,
  type ServiceInfo,
  type ServicesResponse,
  type ServiceState,
} from '@ericminassian/platform-core';
import { Link } from '@tanstack/react-router';
import { Play, RotateCw, Square } from 'lucide-react';
import { type ReactElement, type ReactNode, useState } from 'react';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { ConfirmAction } from '../../components/actions/confirm-action.tsx';
import { report } from '../../components/actions/report.ts';
import { ChartMenu } from '../../components/metrics/chart-panel.tsx';
import {
  EmptyState,
  Loaded,
  Mono,
  PageHeader,
  Panel,
  StatusPill,
  type Tone,
} from '../../components/page.tsx';
import { type PointSeries, PointsChart } from '../../components/points/points-chart.tsx';
import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Field, FieldDescription, FieldLabel } from '../../components/ui/field.tsx';
import { Input } from '../../components/ui/input.tsx';
import { family } from '../../data/atoms.ts';
import { useLiveManifest } from '../../data/hooks.ts';
import { fmtDateTime, fmtNum, fmtUsdCents, relTime, shortId } from '../../format.ts';
import { useAutoRefresh, useStage, useSticky, useTime } from '../../lib/hooks.ts';
import { usePrefs } from '../../lib/prefs.tsx';
import { apiTime, describeTime, type TimeSearch } from '../../lib/time.ts';
import { appRoute } from '../../router.tsx';

/** Reactivity key of an app's services: starting, stopping or restarting one refetches them. */
const servicesChanged = (app: string) => [`services:${app}`];

// A failing service stays failing until someone changes it, so only a start is followed closely.
const settling: ReadonlySet<ServiceState> = new Set(['starting']);

const servicesAtom = family((k: { app: string; stage: string; time: TimeSearch }) =>
  fresh(
    ApiClient.query('observe', 'services', {
      params: { app: k.app },
      query: { stage: k.stage, ...apiTime(k.time) },
      reactivityKeys: servicesChanged(k.app),
      timeToLive,
    }),
    // Follows a rollout or replacement closely, then settles into a slower poll.
    { every: (d) => (d.services.some((s) => settling.has(s.state)) ? '5 seconds' : '30 seconds') },
  ),
);
const startAtom = ApiClient.mutation('manage', 'startService');
const stopAtom = ApiClient.mutation('manage', 'stopService');
const restartAtom = ApiClient.mutation('manage', 'restartService');

const STATE: Record<ServiceState, { tone: Tone; label: string }> = {
  running: { tone: 'ok', label: 'Running' },
  starting: { tone: 'info', label: 'Starting' },
  failing: { tone: 'bad', label: 'Failing' },
  stopped: { tone: 'muted', label: 'Stopped' },
};

/** ECS events shown per service; the API sends up to ten. */
const EVENTS_SHOWN = 5;

const USAGE: readonly PointSeries<'cpu' | 'memory'>[] = [
  { key: 'cpu', label: 'CPU', color: 'var(--chart-1)' },
  { key: 'memory', label: 'Memory', color: 'var(--chart-2)' },
];
const percent = (v: number) => `${Math.round(v)}%`;

/** The same lines as a series query, for the chart's menu (Metrics, dashboards). */
const usageView = (name: string): MetricsView => ({
  kind: 'metrics',
  queries: [
    { id: 'a', metric: 'service', stat: 'avg', filter: { names: [name], measure: 'cpu' }, label: 'CPU' },
    {
      id: 'b',
      metric: 'service',
      stat: 'avg',
      filter: { names: [name], measure: 'memory' },
      label: 'Memory',
    },
  ],
  chart: 'line',
});

export function ServicesPage(): ReactElement {
  const { app } = appRoute.useParams();
  const stage = useStage();
  const time = useTime();
  const atom = servicesAtom({ app, stage, time: time.search });
  useAutoRefresh(atom, time.search.from === undefined);
  const result = useSticky(useAtomValue(atom));
  const manifest = useLiveManifest(app, stage);
  return (
    <>
      <PageHeader title="Services" description={`Long-running containers on ${stage}.`} />
      <Loaded result={result}>
        {(d) =>
          d.services.length === 0 ? (
            <Panel>
              <EmptyState title={`No services on ${stage}`}>
                Declare one under <Mono>services</Mono> in <Mono>plat.config.ts</Mono>.
              </EmptyState>
            </Panel>
          ) : (
            <div className="flex flex-col gap-4">
              {d.services.map((s) => (
                <ServicePanel
                  key={s.name}
                  app={app}
                  stage={stage}
                  time={time.search}
                  res={d.res}
                  service={s}
                  previewMinutes={manifest?.services[s.name]?.previewMinutes}
                />
              ))}
            </div>
          )
        }
      </Loaded>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm break-words tabular">{children}</dd>
    </div>
  );
}

function ServicePanel({
  app,
  stage,
  time,
  res,
  service: s,
  previewMinutes,
}: {
  app: string;
  stage: string;
  time: TimeSearch;
  res: ServicesResponse['res'];
  service: ServiceInfo;
  previewMinutes: number | undefined;
}) {
  const { utc } = usePrefs();
  const state = STATE[s.state];
  const events = s.events.slice(0, EVENTS_SHOWN);
  const range = describeTime(time, utc).toLowerCase();
  return (
    <Panel
      title={
        <span className="flex items-center gap-2.5">
          <Mono className="text-sm">{s.name}</Mono>
          <StatusPill tone={state.tone}>{state.label}</StatusPill>
        </span>
      }
      actions={<ServiceActions app={app} stage={stage} service={s} previewMinutes={previewMinutes} />}
      bodyClassName="flex flex-col gap-4"
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Fact label="Tasks">
          {s.running} of {s.desired} running
          {s.pending > 0 && <span className="text-muted-foreground"> · {s.pending} pending</span>}
        </Fact>
        <Fact label="Size">{describeContainerSize(s)}</Fact>
        <Fact label="Build">
          {s.deployment ? (
            <Link
              to="/apps/$app/deployments"
              params={{ app }}
              search={(prev) => ({ ...prev, deployment: s.deployment })}
              className="font-mono text-[0.8125rem] hover:underline"
            >
              {shortId(s.deployment)}
            </Link>
          ) : (
            '–'
          )}
        </Fact>
        <Fact label="Started">
          <span title={s.startedAt ? fmtDateTime(s.startedAt) : undefined}>
            {s.startedAt ? relTime(s.startedAt) : '–'}
          </span>
        </Fact>
        <Fact label="Stops">
          <span title={s.stopsAt ? fmtDateTime(s.stopsAt) : undefined}>
            {s.stopsAt ? relTime(s.stopsAt) : s.desired > 0 ? 'not scheduled' : '–'}
          </span>
        </Fact>
        <Fact label="Starts">
          <span title={`Containers started, ${range}: deploys, crashes, Spot replacements`}>
            {fmtNum(s.starts)}
          </span>
        </Fact>
        <Fact label="Failed runs">
          <span
            className={s.failedRuns > 0 ? 'text-bad' : undefined}
            title={`Runs of run() that failed and were rerun in the same container, ${range}`}
          >
            {fmtNum(s.failedRuns)}
          </span>
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
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border bg-background px-3 py-2 text-sm">
          <span className="text-muted-foreground">Last task stopped</span>
          <span title={fmtDateTime(s.lastStop.at)}>{relTime(s.lastStop.at)}:</span>
          <span className="min-w-0 break-words">{s.lastStop.reason}</span>
          {s.lastStop.exitCode !== undefined && (
            <Mono className="text-muted-foreground">exit {s.lastStop.exitCode}</Mono>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="flex-1 text-xs font-medium text-muted-foreground">CPU and memory, % of size</h3>
            <ChartMenu app={app} stage={stage} title={`${s.name} CPU and memory`} view={usageView(s.name)} />
          </div>
          <PointsChart
            points={s.points}
            res={res}
            series={USAGE}
            kind="line"
            format={percent}
            height={170}
            minTop={100}
            ariaLabel={`${s.name} CPU and memory`}
          />
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">ECS events</h3>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recent events.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {events.map((e) => (
                <li key={`${e.at}${e.message}`} className="grid grid-cols-[4.5rem_1fr] gap-2 text-sm">
                  <span className="text-xs text-muted-foreground tabular" title={fmtDateTime(e.at)}>
                    {relTime(e.at)}
                  </span>
                  <span className="min-w-0 font-mono text-xs leading-5 break-words">{e.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}

function ServiceActions({
  app,
  stage,
  service: s,
  previewMinutes,
}: {
  app: string;
  stage: string;
  service: ServiceInfo;
  previewMinutes: number | undefined;
}) {
  const [start, startService] = useAtom(startAtom, { mode: 'promiseExit' });
  const [stop, stopService] = useAtom(stopAtom, { mode: 'promiseExit' });
  const [restart, restartService] = useAtom(restartAtom, { mode: 'promiseExit' });
  const [starting, setStarting] = useState(false);
  const busy = start.waiting || stop.waiting || restart.waiting;
  const request = {
    params: { app, name: s.name },
    query: { stage },
    reactivityKeys: servicesChanged(app),
  };
  if (s.desired === 0) {
    return (
      <>
        <Button size="sm" disabled={busy} onClick={() => setStarting(true)}>
          <Play />
          Start
        </Button>
        <StartDialog
          open={starting}
          onOpenChange={setStarting}
          name={s.name}
          stage={stage}
          previewMinutes={previewMinutes}
          busy={start.waiting}
          onStart={async (minutes) => {
            const done = await report(
              startService({ ...request, payload: minutes === undefined ? {} : { minutes } }),
              (r) =>
                r.stopsAt ? `Starting ${s.name}; it stops ${relTime(r.stopsAt)}` : `Starting ${s.name}`,
            );
            if (done) setStarting(false);
          }}
        />
      </>
    );
  }
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void report(restartService(request), `Replacing ${s.name}'s task`)}
      >
        <RotateCw />
        Restart
      </Button>
      <ConfirmAction
        trigger={<Button variant="outline" size="sm" />}
        disabled={busy}
        title={`Stop ${s.name}?`}
        description={`It scales to zero on ${stage} until it's started again or the stage is redeployed.`}
        confirmLabel="Stop"
        onConfirm={() => report(stopService(request), `Stopping ${s.name}`)}
      >
        <Square />
        Stop
      </ConfirmAction>
    </>
  );
}

/**
 * Starts a stopped service, until it's stopped or for a number of minutes.
 * A preview always gets a stop: by default after the service's
 * `previewMinutes` (30 when that is 0).
 */
function StartDialog({
  open,
  onOpenChange,
  name,
  stage,
  previewMinutes,
  busy,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  stage: string;
  previewMinutes: number | undefined;
  busy: boolean;
  onStart: (minutes: number | undefined) => Promise<void>;
}) {
  const [minutes, setMinutes] = useState('');
  const preview = stage !== 'prod';
  const parsed = minutes.trim() === '' ? undefined : Number(minutes);
  const invalid = parsed !== undefined && (!Number.isInteger(parsed) || parsed < 1 || parsed > 1440);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!invalid) void onStart(parsed);
          }}
        >
          <DialogHeader>
            <DialogTitle>Start {name}</DialogTitle>
            <DialogDescription>Runs one task on {stage}.</DialogDescription>
          </DialogHeader>
          <Field data-invalid={invalid || undefined}>
            <FieldLabel htmlFor="service-minutes">Stop after (minutes)</FieldLabel>
            <Input
              id="service-minutes"
              inputMode="numeric"
              placeholder={preview ? String(previewMinutes || 30) : 'Keep running'}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              aria-invalid={invalid || undefined}
            />
            <FieldDescription>
              {invalid
                ? 'A whole number of minutes, from 1 to 1440.'
                : preview
                  ? `Empty stops it after ${previewMinutes || 30} minutes, the default for previews.`
                  : 'Empty keeps it running until it is stopped.'}
            </FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || invalid}>
              {busy ? 'Starting…' : 'Start'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
