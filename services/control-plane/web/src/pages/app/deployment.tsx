/**
 * One deployment: what it ran and where it came from, its event log
 * (followed every two seconds while it runs) and the manifest it deployed.
 * A succeeded deployment that isn't live can be rolled back to.
 */
import { useAtomValue } from '@effect/atom-react';
import type { DeploymentRecord, ResolvedManifest } from '@ericminassian/platform-core';
import { Link } from '@tanstack/react-router';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { ArrowLeft, ArrowUpRight, ScrollText } from 'lucide-react';
import { type ReactElement, useEffect, useRef } from 'react';
import {
  actorLabel,
  COMPUTE_LABEL,
  DeploymentSource,
  DeploymentState,
  inProgress,
  RollbackButton,
  tookOf,
  usePoll,
  useRollback,
} from '../../components/deployments/shared.tsx';
import {
  Detail,
  ErrorNotice,
  Fact,
  Facts,
  Loaded,
  Loading,
  Mono,
  PageHeader,
  Panel,
} from '../../components/page.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { deploymentAtom } from '../../data/atoms.ts';
import { stageOf, useAppSummary } from '../../data/hooks.ts';
import { fmtDateTime, shortId } from '../../format.ts';
import { deploymentRoute } from '../../router.tsx';

export function DeploymentPage(): ReactElement {
  const { app, deployment: id } = deploymentRoute.useParams();
  const atom = deploymentAtom(id);
  const result = useAtomValue(atom);
  const d = Option.getOrUndefined(AsyncResult.value(result));
  usePoll(atom, d && inProgress.has(d.status) ? 2_000 : undefined);
  const summary = Option.getOrUndefined(AsyncResult.value(useAppSummary(app)));
  const live = d ? stageOf(summary, d.stage)?.currentDeployment : undefined;
  const repo = summary?.app.repo;
  const { busy, rollBack } = useRollback(app);
  return (
    <>
      <Link
        to="/apps/$app/deployments"
        params={{ app }}
        search={(prev) => ({ ...prev, stage: d && d.stage !== 'prod' ? d.stage : undefined })}
        className="-mb-2 inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-hidden hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
      >
        <ArrowLeft className="size-4" />
        Deployments
      </Link>
      <PageHeader
        title={
          <>
            <Mono className="text-2xl font-semibold tracking-tight">{shortId(id)}</Mono>
            {d && d.id === live && <Badge variant="info">Current</Badge>}
          </>
        }
        description={d ? (d.message?.split('\n')[0] ?? `Deployment to ${d.stage}`) : undefined}
        actions={
          d && (
            <>
              <Button
                variant="outline"
                size="sm"
                render={
                  <Link
                    to="/apps/$app/logs"
                    params={{ app }}
                    search={(prev) => ({
                      ...prev,
                      stage: d.stage === 'prod' ? undefined : d.stage,
                      f: { revs: [d.id] },
                    })}
                  />
                }
              >
                <ScrollText />
                Its log lines
              </Button>
              {d.id !== live && d.status === 'succeeded' && (
                <RollbackButton
                  stage={d.stage}
                  deployment={d}
                  busy={busy}
                  onRollback={() => rollBack(d.stage, d)}
                  trigger={<Button variant="outline" size="sm" />}
                  label={`Roll ${d.stage} back to this`}
                />
              )}
              {d.url && (
                <Button
                  size="sm"
                  render={<a href={d.url} target="_blank" rel="noreferrer" aria-label="Visit" />}
                >
                  Visit
                  <ArrowUpRight />
                </Button>
              )}
            </>
          )
        }
      />
      <Loaded result={result} loading={<Loading className="h-64" />}>
        {(dep) => (
          <div className="flex flex-col gap-5">
            {dep.error && <ErrorNotice error={dep.error} />}
            <Details d={dep} repo={repo} />
            <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[3fr_2fr]">
              <EventLog d={dep} />
              {dep.manifest && <ManifestSummary manifest={dep.manifest} />}
            </div>
          </div>
        )}
      </Loaded>
    </>
  );
}

function Details({ d, repo }: { d: DeploymentRecord; repo: string | undefined }) {
  const took = tookOf(d);
  return (
    <Panel>
      <div className="grid grid-cols-1 gap-x-10 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
        <Detail label="Status">
          <DeploymentState d={d} />
        </Detail>
        <Detail label="Stage">
          <Mono>{d.stage}</Mono>
        </Detail>
        <Detail label="Created">
          <span title={fmtDateTime(d.createdAt)}>
            {fmtDateTime(d.createdAt)} by {actorLabel(d.actor)}
          </span>
        </Detail>
        <Detail label="Build time">{took ?? 'still running'}</Detail>
        <Detail label="Source" className="sm:col-span-2">
          <DeploymentSource d={d} repo={repo} />
        </Detail>
        <Detail label="Compute">
          {d.compute ? COMPUTE_LABEL[d.compute] : '–'}
          {d.computeSwitchOf && (
            <span className="block text-xs text-muted-foreground">
              A switch by the platform: runs the build of{' '}
              <Mono className="text-xs">{shortId(d.computeSwitchOf)}</Mono> again.
            </span>
          )}
        </Detail>
        <Detail label="SDK">{d.sdk ? <Mono>{d.sdk}</Mono> : 'before 0.4.0'}</Detail>
        {d.url && (
          <Detail label="URL" className="sm:col-span-2">
            <a
              href={d.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-sm outline-hidden hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
            >
              {d.url.replace(/^https?:\/\//, '')}
              <ArrowUpRight className="size-3.5 text-subtle" />
            </a>
          </Detail>
        )}
      </div>
    </Panel>
  );
}

const LEVEL_CLASS = { info: 'text-foreground', warn: 'text-warn', error: 'text-bad' } as const;

function EventLog({ d }: { d: DeploymentRecord }) {
  const end = useRef<HTMLDivElement>(null);
  const running = inProgress.has(d.status);
  const lines = d.events.length;
  // Keeps the newest line in view while the log grows.
  useEffect(() => {
    if (running && lines > 0) end.current?.scrollIntoView({ block: 'nearest' });
  }, [lines, running]);
  return (
    <Panel flush title="Event log" description={running ? 'Following while it runs' : `${lines} events`}>
      <div className="max-h-[28rem] overflow-y-auto border-t bg-muted px-5 py-3 font-mono text-xs leading-6">
        {lines === 0 ? (
          <span className="text-muted-foreground">
            {running ? 'Waiting for the first step…' : 'No events.'}
          </span>
        ) : (
          d.events.map((e) => (
            <div
              key={`${e.ts}:${e.level}:${e.msg}:${e.resource ?? ''}`}
              className="grid grid-cols-[5.5rem_1fr] gap-x-3 break-words"
            >
              <span className="text-subtle tabular">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className={LEVEL_CLASS[e.level]}>
                {e.msg}
                {e.resource && <span className="text-muted-foreground"> · {e.resource}</span>}
              </span>
            </div>
          ))
        )}
        <div ref={end} />
      </div>
    </Panel>
  );
}

function ManifestSummary({ manifest: m }: { manifest: ResolvedManifest }) {
  const queues = Object.keys(m.queues);
  const crons = Object.entries(m.crons);
  return (
    <Panel title="Manifest" description="What this deployment declared">
      <Facts className="grid-cols-[6.5rem_1fr]">
        <Fact label="Web">
          {m.web
            ? [
                m.web.server && `server ${m.web.server}`,
                m.web.static && `static ${m.web.static}${m.web.spa ? ' (SPA)' : ''}`,
                `compute ${m.web.compute}`,
                `${m.web.memoryMb} MB`,
                `${m.web.timeoutSeconds}s timeout`,
              ]
                .filter(Boolean)
                .join(' · ')
            : 'none'}
        </Fact>
        <Fact label="Sign-in">{m.auth.enabled ? (m.auth.required ? 'required' : 'optional') : 'off'}</Fact>
        <Fact label="Database">{m.db ? 'on' : 'off'}</Fact>
        <Fact label="Queues">
          <Names names={queues} />
        </Fact>
        <Fact label="Events">
          <Names names={m.events} />
        </Fact>
        <Fact label="Crons">
          {crons.length ? (
            <span className="flex flex-col">
              {crons.map(([name, c]) => (
                <span key={name}>
                  <Mono>{name}</Mono> <Mono className="text-muted-foreground">{c.schedule}</Mono>
                </span>
              ))}
            </span>
          ) : (
            'none'
          )}
        </Fact>
        <Fact label="Storage">
          <Names names={m.storage} />
        </Fact>
        <Fact label="Secrets">
          <Names names={m.secrets} />
        </Fact>
        <Fact label="Realtime">
          {m.realtime ? (
            <>
              <Names names={m.realtime.channels} /> ·{' '}
              {m.realtime.subscribe === 'signed-in' ? 'signed-in' : 'public'}
            </>
          ) : (
            'off'
          )}
        </Fact>
        <Fact label="Email">
          {m.email ? `${m.email.name ?? 'on'} · ${m.email.dailyLimit} recipients a day` : 'off'}
        </Fact>
      </Facts>
    </Panel>
  );
}

function Names({ names }: { names: readonly string[] }) {
  if (names.length === 0) return <>none</>;
  return (
    <span className="font-mono text-[0.8125rem]">
      {names.map((n, i) => (
        <span key={n}>
          {i > 0 && <span className="text-subtle">, </span>}
          {n}
        </span>
      ))}
    </span>
  );
}
