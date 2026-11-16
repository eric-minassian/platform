import { readFileSync } from 'node:fs';
import {
  checkSeriesQuery,
  type CustomMetricsResponse,
  type DataCollections,
  describeQuery,
  type LimitsResponse,
  type LogLine,
  METRIC_STATS,
  QueryResolution,
  RESOURCE_KEY_PATTERN,
  STATUS_CLASSES,
  type SeriesFilter,
  SeriesGroupBy,
  SeriesMetric,
  SeriesOutcome,
  type SeriesQuery,
  type SeriesResponse,
  SeriesStat,
  SLOW_TRACE_MS,
  type StatusClass,
  type TelemetryEvent,
  TRACE_SAMPLE_RATE,
} from '@ericminassian/platform-core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { formatDuration, formatEvent } from '../dev/pretty.ts';
import { CliError, EXIT, isJsonMode, result, sparkline, table } from '../util/output.ts';
import { shortTime, sinceRange } from '../util/time.ts';
import { action, apiFor, appFor, type CommonOpts, withTarget } from './common.ts';

type TargetOpts = CommonOpts & { stage: string };

/**
 * `plat metrics`' custom metrics: a `metrics.count` metric (unit `count`)
 * by its total, a `metrics.value` one by its average too, each over time.
 */
export function formatCustomMetrics(metrics: CustomMetricsResponse['metrics']): string[] {
  const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
  return [
    pc.bold('custom metrics'),
    table(
      metrics.map((m) => {
        const count = m.unit === 'count';
        return {
          metric: m.name,
          unit: count ? '' : (m.unit ?? ''),
          total: n(m.sum),
          average: count || !m.count ? '-' : n(m.sum / m.count),
          recorded: m.count,
          'over time': sparkline(m.points.map((p) => (count ? p.sum : p.count ? p.sum / p.count : null))),
        };
      }),
    ),
  ];
}

/** `plat metrics`' rate limits: checks per limit, most denied first, with denials over time. */
export function formatLimits(limits: LimitsResponse['limits']): string[] {
  const pct = (denied: number, total: number) => (total ? `${((denied / total) * 100).toFixed(1)}%` : '-');
  return [
    pc.bold('rate limits'),
    table(
      limits.map((l) => ({
        limit: l.name,
        allowed: l.allowed,
        denied: l.denied ? pc.yellow(String(l.denied)) : 0,
        'denied %': pct(l.denied, l.allowed + l.denied),
        'denied over time': sparkline(l.points.map((p) => p.denied)),
      })),
    ),
  ];
}

/** The flags that make one explorer query (`plat metrics --metric`, `plat alerts create`). */
export interface SeriesFlags {
  metric?: string;
  stat?: string;
  filter?: string[];
  by?: string;
}

const usage = (message: string) => new CliError(message, { exitCode: EXIT.usage });

const oneOf = <L extends string>(literals: readonly L[], value: string, flag: string): L => {
  const found = literals.find((l) => l === value);
  if (found === undefined) throw usage(`${flag} is one of ${literals.join(', ')}, not "${value}"`);
  return found;
};

/**
 * `--filter key=value` flags as a query's filter: `route`, `status`, `job`
 * and `name` may repeat (any of them matches), `outcome` and `measure` can't.
 */
export function parseSeriesFilter(pairs: readonly string[]): SeriesFilter | undefined {
  const routes: string[] = [];
  const status: StatusClass[] = [];
  const jobs: string[] = [];
  const names: string[] = [];
  let outcome: SeriesOutcome | undefined;
  let measure: string | undefined;
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const key = pair.slice(0, Math.max(at, 0)).trim();
    const value = pair.slice(at + 1).trim();
    if (at <= 0 || !value) throw usage(`--filter expects key=value, got "${pair}"`);
    if (key === 'route') routes.push(value);
    else if (key === 'status') status.push(oneOf(STATUS_CLASSES, value, 'status'));
    else if (key === 'job') jobs.push(value);
    else if (key === 'name') names.push(value);
    else if ((key === 'outcome' && outcome) || (key === 'measure' && measure))
      throw usage(`--filter ${key} can be given once`);
    else if (key === 'outcome') outcome = oneOf(SeriesOutcome.literals, value, 'outcome');
    else if (key === 'measure') measure = value;
    else throw usage(`--filter keys are route, status, job, name, outcome and measure, not "${key}"`);
  }
  const filter: SeriesFilter = {
    ...(routes.length ? { routes } : {}),
    ...(status.length ? { status } : {}),
    ...(jobs.length ? { jobs } : {}),
    ...(names.length ? { names } : {}),
    ...(outcome ? { outcome } : {}),
    ...(measure ? { measure } : {}),
  };
  return Object.keys(filter).length ? filter : undefined;
}

/**
 * The query the flags describe, checked as the API would (`alert`: as a
 * rule's). Over `base` (a rule being changed), what isn't given stays as it
 * was while the metric does.
 */
export function seriesQueryOf(
  flags: SeriesFlags,
  options: { readonly alert?: boolean; readonly base?: SeriesQuery } = {},
): SeriesQuery {
  const { base } = options;
  const given = flags.metric ?? base?.metric;
  if (given === undefined) throw usage('--metric is required');
  const metric = oneOf(SeriesMetric.literals, given, '--metric');
  const kept = metric === base?.metric ? base : undefined;
  const stat =
    flags.stat === undefined
      ? (kept?.stat ?? METRIC_STATS[metric][0]!)
      : oneOf(SeriesStat.literals, flags.stat, '--stat');
  const filter = flags.filter?.length ? parseSeriesFilter(flags.filter) : kept?.filter;
  const groupBy = flags.by === undefined ? kept?.groupBy : oneOf(SeriesGroupBy.literals, flags.by, '--by');
  const query: SeriesQuery = { metric, stat, ...(filter ? { filter } : {}), ...(groupBy ? { groupBy } : {}) };
  const problem = checkSeriesQuery(query, options);
  if (problem) throw usage(problem);
  return query;
}

export const resolutionOf = (res: string): QueryResolution => oneOf(QueryResolution.literals, res, '--res');

const UNIT_SUFFIX: Record<string, string> = { percent: '%', ms: ' ms', per_second: '/s', count: '' };

/** A value with its unit: `2.5%`, `120 ms`, `0.4/s`, `12 usd`. */
export function formatSeriesValue(v: number | null | undefined, unit: string): string {
  if (v === null || v === undefined) return '-';
  const n = Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return `${n}${UNIT_SUFFIX[unit] ?? ` ${unit}`}`;
}

/**
 * `plat metrics --metric`: what the query measures, then a line per series
 * with its total (counts and sums) or average, its highest bucket and a
 * sparkline, and why the answer differs from what was asked.
 */
export function formatSeries(r: SeriesResponse, query: SeriesQuery, heading: string): string {
  const additive = query.stat === 'count' || query.stat === 'sum' || query.stat === 'histogram';
  const unit = query.stat === 'histogram' ? 'count' : r.unit;
  const rows = r.series.map((s) => {
    const values = s.values.filter((v): v is number => v !== null);
    const total = values.reduce((a, b) => a + b, 0);
    return {
      series: s.key,
      [additive ? 'total' : 'avg']: values.length
        ? formatSeriesValue(additive ? total : total / values.length, unit)
        : '-',
      max: values.length ? formatSeriesValue(Math.max(...values), unit) : '-',
      'over time': sparkline([...s.values]),
    };
  });
  const lines = [
    heading,
    `${describeQuery(query)} ${pc.dim(`· ${r.res} buckets`)}`,
    '',
    rows.length ? table(rows) : pc.dim('(no data)'),
  ];
  if (query.stat === 'histogram') lines.push(pc.dim('each bucket’s latency histogram is in --json'));
  if (r.note) lines.push(pc.dim(`note: ${r.note}`));
  return lines.join('\n');
}

export function registerObserve(program: Command): void {
  withTarget(
    program
      .command('logs')
      .description('search recent logs (web, worker and services); --follow streams live')
      .option('--since <duration>', 'how far back', '1h')
      .option('--filter <text>', 'only lines containing this text / CloudWatch filter pattern')
      .option('--stream <name>', 'only web, worker or one service (by name)')
      .option('--limit <n>', 'max lines', '200')
      .option('-f, --follow', 'stream new lines (live tail)')
      .option('--runtime', "include the Lambda runtime's own records (hidden by default)"),
  ).action(
    action(
      async (
        opts: TargetOpts & {
          since: string;
          filter?: string;
          stream?: string;
          limit: string;
          follow?: boolean;
          runtime?: boolean;
        },
      ) => {
        const stream = opts.stream === undefined ? undefined : logStream(opts.stream);
        const keep = (l: LogLine) =>
          (opts.runtime || l.level !== 'system') && (!stream || l.stream === stream);
        const api = apiFor(opts);
        const app = await appFor(opts);
        if (opts.follow) {
          const ac = new AbortController();
          process.once('SIGINT', () => ac.abort());
          try {
            for await (const line of api.tailLogs(
              app,
              {
                stage: opts.stage,
                ...(opts.filter ? { filter: opts.filter } : {}),
                ...(stream ? { stream } : {}),
              },
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
          ...(stream ? { stream } : {}),
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
      .description(
        'requests, errors, latency, jobs, realtime, custom metrics and rate limits for a stage, or with --metric one query (a line per group)',
      )
      .option('--since <duration>', 'time range', '6h')
      .option('--metric <metric>', `query one metric: ${SeriesMetric.literals.join(', ')}`)
      .option('--stat <stat>', "how each bucket is summarized (default: the metric's own, e.g. count or p95)")
      .option(
        '--filter <key=value>',
        'route, status, job, name (repeatable), outcome or measure',
        (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
      )
      .option('--by <dimension>', `one line per ${SeriesGroupBy.literals.join(', ')}`)
      .option('--res <res>', `bucket size: ${QueryResolution.literals.join(', ')}`),
  ).action(
    action(async (opts: TargetOpts & SeriesFlags & { since: string; res?: string }) => {
      const api = apiFor(opts);
      const app = await appFor(opts);
      if (opts.metric === undefined) {
        if (opts.stat || opts.filter?.length || opts.by || opts.res)
          throw new CliError('--stat, --filter, --by and --res go with --metric', { exitCode: EXIT.usage });
      } else {
        const query = seriesQueryOf(opts);
        const res = opts.res === undefined ? undefined : resolutionOf(opts.res);
        const { from, to } = sinceRange(opts.since);
        const r = await api.series(app, { stage: opts.stage, query, from, to, ...(res ? { res } : {}) });
        result(r, (v) =>
          formatSeries(v, query, `${pc.bold(app)} ${pc.dim(`${opts.stage} · last ${opts.since}`)}`),
        );
        return;
      }
      const range = sinceRange(opts.since);
      const [metrics, routes, jobs, realtime, custom, limits] = await Promise.all([
        api.metrics(app, { stage: opts.stage, ...range }),
        api.routes(app, { stage: opts.stage, from: range.from, to: range.to }).catch(() => []),
        api
          .jobs(app, { stage: opts.stage, from: range.from, to: range.to })
          .catch(() => ({ jobs: [], queues: [] })),
        // Control planes from before realtime answer 404.
        api.realtime(app, { stage: opts.stage, ...range }).catch(() => undefined),
        // Likewise for custom metrics and rate limits.
        api.customMetrics(app, { stage: opts.stage, from: range.from, to: range.to }).catch(() => undefined),
        api.limits(app, { stage: opts.stage, from: range.from, to: range.to }).catch(() => undefined),
      ]);
      const shown = {
        metrics,
        routes,
        ...jobs,
        ...(realtime?.enabled ? { realtime } : {}),
        customMetrics: custom?.metrics ?? [],
        rateLimits: limits?.limits ?? [],
      };
      result(shown, (v) => {
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
        if (v.customMetrics.length) lines.push('', ...formatCustomMetrics(v.customMetrics));
        if (v.rateLimits.length) lines.push('', ...formatLimits(v.rateLimits));
        if (v.queues.length) {
          lines.push(
            '',
            pc.bold('queues'),
            table(
              v.queues.map((q) => ({
                queue: q.name,
                scheduled: q.scheduled,
                dead: q.deadLetter,
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

/**
 * `--stream` → the API's stream: `web`, `worker`, or a service's name as
 * `service:<name>` (also accepted as is, for a service named web or worker).
 */
export function logStream(name: string): string {
  if (name === 'web' || name === 'worker') return name;
  const service = name.startsWith('service:') ? name.slice('service:'.length) : name;
  if (!RESOURCE_KEY_PATTERN.test(service)) {
    throw new CliError(`--stream takes web, worker or a service name, got "${name}"`, {
      exitCode: EXIT.usage,
    });
  }
  return `service:${service}`;
}

export function formatLogLine(l: LogLine): string {
  const ts = pc.dim(shortTime(l.ts));
  const body = l.event ? (formatEvent(l.event, { spans: true }) ?? l.message) : l.message;
  return `${ts} ${streamLabel(l.stream)} ${body}`;
}

function streamLabel(stream: string): string {
  if (stream === 'web') return pc.green('web   ');
  if (stream === 'worker') return pc.yellow('worker');
  if (stream.startsWith('service:')) return pc.magenta(stream.slice('service:'.length).padEnd(6));
  return stream.padEnd(6);
}

export function formatTrace(events: readonly TelemetryEvent[]): string {
  if (events.length === 0) return pc.dim('(no events for this trace)');
  const sorted = events.toSorted((a, b) => a.ts - b.ts);
  const t0 = sorted[0]!.ts;
  const lines = sorted.map((e) => {
    const offset = `+${String(e.ts - t0).padStart(5)}ms`;
    const line = `${pc.dim(offset)} ${formatEvent(e, { spans: true }) ?? e.t}`;
    const note = unrecordedCalls(e);
    return note ? `${line}\n${' '.repeat(offset.length + 3)}${pc.dim(note)}` : line;
  });
  if (sorted.some((e) => unrecordedCalls(e)))
    lines.push(
      pc.dim(
        `calls are recorded for requests and jobs that fail or take ${SLOW_TRACE_MS / 1_000}s or longer, and for 1 in ${Math.round(1 / TRACE_SAMPLE_RATE)} traces`,
      ),
    );
  return lines.join('\n');
}

/** `3 calls, 12ms, not recorded` for a request or job that counted its spans instead of writing them. */
function unrecordedCalls(e: TelemetryEvent): string | undefined {
  if ((e.t !== 'req' && e.t !== 'job') || !e.calls) return undefined;
  // A line that names its own span id wrote some spans: these are the ones past the cap.
  const calls = `${e.calls} ${e.span ? 'more ' : ''}${e.calls === 1 ? 'call' : 'calls'}`;
  return `${calls}, ${formatDuration(e.callMs ?? 0)}, not recorded`;
}

export function readStdin(): string {
  try {
    return readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  } catch {
    return '';
  }
}
