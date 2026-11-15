import { readFileSync } from 'node:fs';
import type { DataCollections, LogLine, TelemetryEvent } from '@ericminassian/platform-core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { formatEvent } from '../dev/pretty.ts';
import { CliError, EXIT, isJsonMode, result, sparkline, table } from '../util/output.ts';
import { shortTime, sinceRange } from '../util/time.ts';
import { action, apiFor, appFor, type CommonOpts, withTarget } from './common.ts';

type TargetOpts = CommonOpts & { stage: string };

export function registerObserve(program: Command): void {
  withTarget(
    program
      .command('logs')
      .description('search recent logs (web + worker); --follow streams live')
      .option('--since <duration>', 'how far back', '1h')
      .option('--filter <text>', 'only lines containing this text / CloudWatch filter pattern')
      .option('--limit <n>', 'max lines', '200')
      .option('-f, --follow', 'stream new lines (live tail)')
      .option('--runtime', "include the Lambda runtime's own records (hidden by default)"),
  ).action(
    action(
      async (
        opts: TargetOpts & {
          since: string;
          filter?: string;
          limit: string;
          follow?: boolean;
          runtime?: boolean;
        },
      ) => {
        const keep = (l: LogLine) => opts.runtime || l.level !== 'system';
        const api = apiFor(opts);
        const app = await appFor(opts);
        if (opts.follow) {
          const ac = new AbortController();
          process.once('SIGINT', () => ac.abort());
          try {
            for await (const line of api.tailLogs(
              app,
              { stage: opts.stage, ...(opts.filter ? { filter: opts.filter } : {}) },
              ac.signal,
            )) {
              if (!keep(line)) continue;
              process.stdout.write(`${isJsonMode() ? JSON.stringify(line) : formatLogLine(line)}\n`);
            }
          } catch (err) {
            if ((err as Error).name !== 'AbortError') throw err;
          }
          return;
        }
        const { from, to } = sinceRange(opts.since);
        const res = await api.logs(app, {
          stage: opts.stage,
          from,
          to,
          limit: Number(opts.limit),
          ...(opts.filter ? { filter: opts.filter } : {}),
        });
        const shown = { ...res, lines: res.lines.filter(keep) };
        result(shown, (r) =>
          r.lines.length ? r.lines.map(formatLogLine).join('\n') : pc.dim('(no log lines)'),
        );
      },
    ),
  );

  withTarget(
    program
      .command('metrics')
      .description('requests, errors, latency, jobs and realtime for a stage')
      .option('--since <duration>', 'time range', '6h'),
  ).action(
    action(async (opts: TargetOpts & { since: string }) => {
      const api = apiFor(opts);
      const app = await appFor(opts);
      const range = sinceRange(opts.since);
      const [metrics, routes, jobs, realtime] = await Promise.all([
        api.metrics(app, { stage: opts.stage, ...range }),
        api.routes(app, { stage: opts.stage, from: range.from, to: range.to }).catch(() => []),
        api
          .jobs(app, { stage: opts.stage, from: range.from, to: range.to })
          .catch(() => ({ jobs: [], queues: [] })),
        // Control planes from before realtime answer 404.
        api.realtime(app, { stage: opts.stage, ...range }).catch(() => undefined),
      ]);
      result({ metrics, routes, ...jobs, ...(realtime?.enabled ? { realtime } : {}) }, (v) => {
        const pts = v.metrics.points;
        const total = pts.reduce((a, p) => a + p.req, 0);
        const errors = pts.reduce((a, p) => a + p.s5xx, 0);
        const p95s = pts.map((p) => p.p95).filter((x): x is number => x !== null);
        const lines = [
          `${pc.bold(app)} ${pc.dim(`${opts.stage} · last ${opts.since} · ${v.metrics.res} buckets`)}`,
          '',
          `  requests  ${String(total).padStart(8)}  ${sparkline(pts.map((p) => p.req))}`,
          `  5xx       ${String(errors).padStart(8)}  ${pc.red(sparkline(pts.map((p) => p.s5xx)))}`,
          `  p95 (ms)  ${String(p95s.length ? Math.max(...p95s) : '-').padStart(8)}  ${sparkline(pts.map((p) => p.p95))}`,
          `  cold      ${String(pts.reduce((a, p) => a + p.cold, 0)).padStart(8)}  ${sparkline(pts.map((p) => p.cold))}`,
        ];
        if (v.routes.length) {
          lines.push(
            '',
            pc.bold('routes'),
            table(
              v.routes.map((r) => ({
                method: r.method,
                route: r.route,
                req: r.req,
                '5xx': r.s5xx,
                '4xx': r.s4xx,
                p50: r.p50 ?? '-',
                p95: r.p95 ?? '-',
              })),
            ),
          );
        }
        if (v.jobs.length) {
          lines.push(
            '',
            pc.bold('jobs'),
            table(
              v.jobs.map((j) => ({
                job: `${j.kind}:${j.name}`,
                ok: j.ok,
                error: j.error,
                p95: j.p95 ?? '-',
                last: j.lastRun ? shortTime(j.lastRun) : '-',
              })),
            ),
          );
        }
        if (v.realtime) {
          const rt = v.realtime;
          const rtPts = rt.points;
          lines.push(
            '',
            `${pc.bold('realtime')} ${pc.dim(`${rt.subscribe ?? 'public'} · ${rt.channels.join(', ')}`)}`,
            `  events    ${String(rt.totals.events).padStart(8)}  ${sparkline(rtPts.map((p) => p.events))}`,
            `  subscribes${String(rt.totals.subscribes).padStart(8)}  ${sparkline(rtPts.map((p) => p.subscribes))}`,
            `  errors    ${String(rt.totals.errors).padStart(8)}  ${pc.red(sparkline(rtPts.map((p) => p.errors)))}`,
          );
        }
        if (v.queues.length) {
          lines.push(
            '',
            pc.bold('queues'),
            table(
              v.queues.map((q) => ({
                queue: q.name,
                visible: q.visible,
                inFlight: q.inFlight,
                dlq: q.deadLetter,
                oldest: q.oldestAgeSeconds ?? '-',
              })),
            ),
          );
        }
        return lines.join('\n');
      });
    }),
  );

  withTarget(program.command('errors').description('grouped errors for a stage')).action(
    action(async (opts: TargetOpts) => {
      const groups = await apiFor(opts).errors(await appFor(opts), { stage: opts.stage });
      result(groups, (g) =>
        table(
          g.map((e) => ({
            id: e.fingerprint,
            status: e.status === 'open' ? pc.red('open') : e.status,
            count: e.count,
            error: `${e.name}: ${e.message}`.slice(0, 80),
            where: e.sample.route ?? e.sample.job ?? '',
            last: shortTime(e.lastSeen),
            trace: e.sample.trace ?? '',
          })),
        ),
      );
    }),
  );

  withTarget(
    program
      .command('traces <traceId>')
      .description('every event of one request/job across web, queues and worker'),
  ).action(
    action(async (traceId: string, opts: TargetOpts) => {
      const t = await apiFor(opts).trace(await appFor(opts), traceId, { stage: opts.stage });
      result(t, (v) => formatTrace(v.events));
    }),
  );

  withTarget(
    program
      .command('data [collection]')
      .description('browse database collections or file stores')
      .option('--partition <k=v...>', 'partition key values (repeatable)')
      .option('--store <name>', 'list files in a storage store instead')
      .option('--prefix <prefix>', 'file key prefix (with --store)')
      .option('--cursor <cursor>', 'continue from a previous page')
      .option('--limit <n>', 'page size', '50'),
  ).action(
    action(
      async (
        collection: string | undefined,
        opts: TargetOpts & {
          partition?: string[];
          store?: string;
          prefix?: string;
          cursor?: string;
          limit: string;
        },
      ) => {
        const api = apiFor(opts);
        const app = await appFor(opts);
        if (opts.store) {
          const r = await api.files(app, {
            stage: opts.stage,
            store: opts.store,
            ...(opts.prefix ? { prefix: opts.prefix } : {}),
            ...(opts.cursor ? { cursor: opts.cursor } : {}),
          });
          result(
            r,
            (v) =>
              `${table(v.objects.map((o) => ({ key: o.key, size: o.size, modified: o.lastModified ?? '' })))}${v.cursor ? `\n${pc.dim(`more: --cursor ${v.cursor}`)}` : ''}`,
          );
          return;
        }
        if (!collection) {
          const cols = await api.collections(app, { stage: opts.stage });
          result(cols, (c) => formatCollections(c, opts.stage));
          return;
        }
        const page = await api.items(app, {
          stage: opts.stage,
          collection,
          limit: Number(opts.limit),
          ...(opts.partition ? { partition: parsePartition(opts.partition) } : {}),
          ...(opts.cursor ? { cursor: opts.cursor } : {}),
        });
        result(
          page,
          (v) =>
            `${v.items.map((i) => JSON.stringify(i)).join('\n') || pc.dim('(no items)')}${v.cursor ? `\n${pc.dim(`more: --cursor ${v.cursor}`)}` : ''}`,
        );
      },
    ),
  );
}

export function formatCollections(d: DataCollections, stage: string): string {
  if (!d.database) return pc.dim(`(no database on ${stage}; set db: true in plat.config.ts and deploy)`);
  return d.collections.length ? d.collections.map((c) => c.name).join('\n') : pc.dim('(no collections yet)');
}

/** `["userId=1", "kind=a"]` → `"userId=1&kind=a"` (URL-encoded pairs, as the API expects). */
export function parsePartition(pairs: string[]): string {
  const params = new URLSearchParams();
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) throw new CliError(`--partition expects key=value, got "${p}"`, { exitCode: EXIT.usage });
    params.append(p.slice(0, i), p.slice(i + 1));
  }
  return params.toString();
}

export function formatLogLine(l: LogLine): string {
  const ts = pc.dim(shortTime(l.ts));
  const stream = l.stream === 'web' ? pc.green('web   ') : pc.yellow('worker');
  const body = l.event ? (formatEvent(l.event, { spans: true }) ?? l.message) : l.message;
  return `${ts} ${stream} ${body}`;
}

export function formatTrace(events: readonly TelemetryEvent[]): string {
  if (events.length === 0) return pc.dim('(no events for this trace)');
  const sorted = events.toSorted((a, b) => a.ts - b.ts);
  const t0 = sorted[0]!.ts;
  return sorted
    .map((e) => {
      const offset = `+${String(e.ts - t0).padStart(5)}ms`;
      return `${pc.dim(offset)} ${formatEvent(e, { spans: true }) ?? e.t}`;
    })
    .join('\n');
}

export function readStdin(): string {
  try {
    return readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  } catch {
    return '';
  }
}
