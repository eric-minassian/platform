import {
  describeContainerSize,
  RESOURCE_KEY_PATTERN,
  type ServiceActionResponse,
  type ServiceInfo,
  type ServicesResponse,
  type ServiceState,
} from '@ericminassian/platform-core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { CliError, EXIT, result, table } from '../util/output.ts';
import { shortTime, sinceRange } from '../util/time.ts';
import { action, apiFor, appFor, type CommonOpts, withTarget } from './common.ts';

type TargetOpts = CommonOpts & { stage: string };
type ServiceAction = 'restart' | 'start' | 'stop';

export function registerServices(program: Command): void {
  // `--app`, `--stage` and `--json` live on `services` only: commander parses
  // a parent's options wherever they appear, after a subcommand too.
  const services = withTarget(
    program
      .command('services')
      .description("a stage's long-running services: state, size, cost; restart, start or stop one")
      .option('--since <duration>', 'range for starts and failed runs', '24h'),
  ).action(
    action(async (opts: TargetOpts & { since: string }) => {
      const r = await apiFor(opts).services(await appFor(opts), {
        stage: opts.stage,
        ...sinceRange(opts.since),
      });
      result(r, formatServices);
    }),
  );

  const control = (name: ServiceAction, description: string) =>
    services.command(`${name} <name>`).description(description).configureHelp({ showGlobalOptions: true });

  control('restart', 'replace the running container with a fresh one on the same build').action(
    action((service: string, _opts: CommonOpts, cmd: Command) => runAction(cmd, service, 'restart')),
  );
  control('start', 'run a stopped service (previews stop it again after its previewMinutes)')
    .option('--minutes <n>', 'stop it again after this many minutes (1-1440)')
    .action(action((service: string, _opts: CommonOpts, cmd: Command) => runAction(cmd, service, 'start')));
  control('stop', 'scale a service to zero until it is started again or the stage is redeployed').action(
    action((service: string, _opts: CommonOpts, cmd: Command) => runAction(cmd, service, 'stop')),
  );
}

async function runAction(cmd: Command, service: string, verb: ServiceAction): Promise<void> {
  const opts = cmd.optsWithGlobals<TargetOpts & { minutes?: string }>();
  if (!RESOURCE_KEY_PATTERN.test(service)) {
    throw new CliError(`"${service}" is not a service name`, {
      hint: 'see `plat services` for the stage’s services',
      exitCode: EXIT.usage,
    });
  }
  const minutes = opts.minutes === undefined ? undefined : parseMinutes(opts.minutes);
  const r = await apiFor(opts).serviceAction(await appFor(opts), service, verb, {
    stage: opts.stage,
    ...(minutes !== undefined ? { minutes } : {}),
  });
  result({ stage: opts.stage, action: verb, ...r }, (v) => formatServiceAction(v, v.stage, v.action));
}

function parseMinutes(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1440)
    throw new CliError(`--minutes must be a whole number from 1 to 1440, got ${v}`, { exitCode: EXIT.usage });
  return n;
}

const STATE_COLOR: Record<ServiceState, (s: string) => string> = {
  running: pc.green,
  starting: pc.yellow,
  failing: pc.red,
  stopped: pc.dim,
};

export function formatServices(r: ServicesResponse): string {
  if (r.services.length === 0) return pc.dim(`(no services on ${r.stage})`);
  const lines = [
    table(
      r.services.map((s) => ({
        name: s.name,
        state: STATE_COLOR[s.state](s.state),
        'running/desired': `${s.running}/${s.desired}`,
        size: describeContainerSize(s),
        deployment: s.deployment ?? '-',
        started: s.startedAt ? shortTime(s.startedAt) : '-',
        'stops at': s.stopsAt ? shortTime(s.stopsAt) : '-',
        '≈ monthly': `$${s.monthly.totalUsd.toFixed(2)}`,
      })),
    ),
  ];
  const notes = r.services.flatMap(serviceNotes);
  if (notes.length) lines.push('', ...notes);
  return lines.join('\n');
}

/** What explains a service that isn't simply running: its last stop, and restarts in the range. */
function serviceNotes(s: ServiceInfo): string[] {
  const notes: string[] = [];
  if (s.state !== 'running' && s.state !== 'stopped' && s.lastStop) {
    const code = s.lastStop.exitCode !== undefined ? ` (exit ${s.lastStop.exitCode})` : '';
    notes.push(`${s.name}: last stopped ${shortTime(s.lastStop.at)}: ${s.lastStop.reason}${code}`);
  }
  if (s.failedRuns > 0 || s.starts > 1) {
    notes.push(
      pc.dim(
        `${s.name}: ${plural(s.starts, 'container start')}, ${plural(s.failedRuns, 'failed run')} in range`,
      ),
    );
  }
  return notes;
}

export function formatServiceAction(r: ServiceActionResponse, stage: string, verb: ServiceAction): string {
  if (verb === 'stop')
    return `${pc.green('✓')} stopping ${r.name} on ${stage} until it is started again or the stage is redeployed`;
  const until = r.stopsAt ? `; it stops at ${shortTime(r.stopsAt)}` : '';
  return `${pc.green('✓')} ${verb === 'start' ? 'starting' : 'restarting'} ${r.name} on ${stage}${until}`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
