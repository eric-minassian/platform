import { readFileSync } from 'node:fs';
import {
  checkSeriesQuery,
  type CustomMetricsResponse,
  type DataCollections,
  describeQuery,
  type ErrorGroup,
  type ErrorOccurrencesResponse,
  type InsightsResponse,
  type LimitsResponse,
  type LogContextResponse,
  type LogFilters,
  type LogLevelName,
  type LogLine,
  METRIC_STATS,
  QueryResolution,
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
  type TraceFilters,
  type TracesResponse,
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
      .description('search recent logs (web + worker); --follow streams live')
      .option('--since <duration>', 'how far back', '1h')
      .option('--filter <text>', 'only lines containing this text / CloudWatch filter pattern')
      .option('--stream <name>', 'only web or worker')
      .option('--level <level>', 'only error, warn, info, debug or system lines (repeatable)', collectList)
      .option('--route <pattern>', 'only lines of this route, e.g. /api/items/:id (repeatable)', collect)
      .option('--status <class>', 'only lines with a 2xx, 3xx, 4xx or 5xx status (repeatable)', collectList)
      .option('--rev <deployment>', 'only lines from this deployment (repeatable)', collect)
      .option('--trace <id>', 'only lines of this trace')
      .option('--limit <n>', 'max lines', '200')
      .option('-f, --follow', 'stream new lines (live tail)')
      .option('--around <time>', 'the lines around the one at this time (ISO or epoch ms; needs --stream)')
      .option('--context <n>', 'lines on each side with --around (default 50, up to 200)')
      .option('--insights <query>', 'run a Logs Insights query on the stage over --since and print its table')
      .option('--runtime', "include the Lambda runtime's own records (hidden by default)"),
  ).action(
    action(
      async (
        opts: TargetOpts &
          LogFilterOpts & {
            since: string;
            filter?: string;
            stream?: string;
            limit: string;
            follow?: boolean;
            around?: string;
            context?: string;
            insights?: string;
            runtime?: boolean;
          },
      ) => {
        const stream = opts.stream === undefined ? undefined : logStream(opts.stream);
        const filters = logFilters(opts);
        const runtime = opts.runtime || filters.levels?.includes('system');
        const keep = (l: LogLine) => (runtime || l.level !== 'system') && (!stream || l.stream === stream);
        const api = apiFor(opts);
        const app = await appFor(opts);
        if (opts.insights !== undefined) {
          const { from, to } = sinceRange(opts.since);
          const res = await api.insights(app, {
            stage: opts.stage,
            query: opts.insights,
            from: String(from),
            to: String(to),
          });
          result(res, formatInsights);
          return;
        }
        if (opts.around !== undefined) {
          if (!stream)
            throw new CliError('--around needs --stream (web or worker)', {
              exitCode: EXIT.usage,
            });
          const lines = opts.context === undefined ? undefined : wholeNumber(opts.context, '--context', 200);
          const res = await api.logContext(app, {
            stage: opts.stage,
            stream,
            ts: lineTime(opts.around),
            ...(lines === undefined ? {} : { before: lines, after: lines }),
          });
          result(res, (r) => formatContext(r, { runtime: Boolean(opts.runtime) }));
          return;
        }
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
                filters,
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
          filters,
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

  withTarget(
    program
      .command('errors [fingerprint]')
      .description('grouped errors for a stage; with a fingerprint (the id column), that group')
      .option('--occurrences', 'how often the group happened over --since, and on which deployments')
      .option('--since <duration>', 'range for --occurrences', '7d'),
  ).action(
    action(
      async (
        fingerprint: string | undefined,
        opts: TargetOpts & { occurrences?: boolean; since: string },
      ) => {
        const api = apiFor(opts);
        const app = await appFor(opts);
        if (opts.occurrences) {
          if (!fingerprint)
            throw new CliError('--occurrences needs a fingerprint (the id `plat errors` lists)', {
              exitCode: EXIT.usage,
            });
          const { from, to } = sinceRange(opts.since);
          const res = await api.errorOccurrences(app, fingerprint, { stage: opts.stage, from, to });
          result(res, (r) => formatOccurrences(r, opts.since));
          return;
        }
        const groups = await api.errors(app, { stage: opts.stage });
        if (fingerprint) {
          const group = groups.find((g) => g.fingerprint === fingerprint);
          if (!group)
            throw new CliError(`no error group ${fingerprint} on ${opts.stage}`, {
              hint: 'see `plat errors` for the stage’s groups',
              exitCode: EXIT.notFound,
            });
          result(group, formatErrorGroup);
          return;
        }
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
      },
    ),
  );

  withTarget(
    program
      .command('traces [traceId]')
      .description(
        'requests and jobs that started traces, newest first; with an id, every event of that trace',
      )
      .option('--since <duration>', 'how far back to list', '1h')
      .option('--route <route>', 'only requests of this route, as "METHOD /pattern" (repeatable)', collect)
      .option('--job <job>', 'only runs of this job, as kind:name (repeatable)', collect)
      .option('--failed', 'only 5xx requests and failed jobs')
      .option('--min-ms <ms>', 'only those that took at least this long')
      .option('--recorded', 'only those whose calls were recorded (failed, slow or sampled)')
      .option('--limit <n>', 'max traces (up to 1000)', '100'),
  ).action(
    action(
      async (
        traceId: string | undefined,
        opts: TargetOpts & {
          since: string;
          route?: string[];
          job?: string[];
          failed?: boolean;
          minMs?: string;
          recorded?: boolean;
          limit: string;
        },
      ) => {
        const api = apiFor(opts);
        const app = await appFor(opts);
        if (traceId) {
          const t = await api.trace(app, traceId, { stage: opts.stage });
          result(t, (v) => formatTrace(v.events));
          return;
        }
        const filters: TraceFilters = {
          ...(opts.route?.length ? { routes: opts.route } : {}),
          ...(opts.job?.length ? { jobs: opts.job } : {}),
          ...(opts.failed ? { outcome: 'error' as const } : {}),
          ...(opts.minMs === undefined ? {} : { minMs: wholeNumber(opts.minMs, '--min-ms') }),
          ...(opts.recorded ? { recorded: true } : {}),
        };
        const { from, to } = sinceRange(opts.since);
        const res = await api.traces(app, {
          stage: opts.stage,
          from,
          to,
          filters,
          limit: wholeNumber(opts.limit, '--limit', 1000),
        });
        result(res, formatTraceList);
      },
    ),
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

export function logStream(name: string): string {
  if (name === 'web' || name === 'worker') return name;
  throw new CliError(`--stream takes web or worker, got "${name}"`, { exitCode: EXIT.usage });
}

export function formatLogLine(l: LogLine): string {
  const ts = pc.dim(shortTime(l.ts));
  const body = l.event ? (formatEvent(l.event, { spans: true }) ?? l.message) : l.message;
  return `${ts} ${streamLabel(l.stream)} ${body}`;
}

function streamLabel(stream: string): string {
  if (stream === 'web') return pc.green('web   ');
  if (stream === 'worker') return pc.yellow('worker');
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

// ---------------------------------------------------------------- log filters, Logs Insights, traces

/** A repeatable option's values. */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** A repeatable option that also takes comma-separated values. */
export function collectList(value: string, previous: string[] = []): string[] {
  return [
    ...previous,
    ...value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  ];
}

const LEVELS: readonly LogLevelName[] = ['error', 'warn', 'info', 'debug', 'system'];

interface LogFilterOpts {
  level?: string[];
  route?: string[];
  status?: string[];
  rev?: string[];
  trace?: string;
}

/** `--level`, `--route`, `--status`, `--rev` and `--trace` as the API's structured filters. */
export function logFilters(opts: LogFilterOpts): LogFilters {
  const { level = [], route = [], status = [], rev = [] } = opts;
  for (const l of level)
    if (!LEVELS.some((known) => known === l))
      throw new CliError(`--level takes ${LEVELS.join(', ')}, got "${l}"`, { exitCode: EXIT.usage });
  for (const c of status)
    if (!STATUS_CLASSES.some((s) => s === c))
      throw new CliError(`--status takes ${STATUS_CLASSES.join(', ')}, got "${c}"`, { exitCode: EXIT.usage });
  return {
    ...(level.length ? { levels: level as LogLevelName[] } : {}),
    ...(route.length ? { routes: route } : {}),
    ...(status.length ? { status: status as StatusClass[] } : {}),
    ...(rev.length ? { revs: rev } : {}),
    ...(opts.trace ? { trace: opts.trace } : {}),
  };
}

/** A whole number option, at least 0 (and at most `max`). */
function wholeNumber(value: string, option: string, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  if (!/^\d+$/.test(value.trim()) || n > max)
    throw new CliError(
      `${option} takes a whole number${max < Number.MAX_SAFE_INTEGER ? ` up to ${max}` : ''}`,
      {
        exitCode: EXIT.usage,
      },
    );
  return n;
}

/** `--around`: epoch milliseconds, or an ISO time. */
export function lineTime(value: string): number {
  const t = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(t))
    throw new CliError(`--around takes an ISO time or epoch milliseconds, got "${value}"`, {
      exitCode: EXIT.usage,
    });
  return t;
}

/** The lines around one line, that one marked; runtime records hidden unless asked for (or the anchor). */
export function formatContext(r: LogContextResponse, opts: { runtime: boolean }): string {
  if (r.lines.length === 0) return pc.dim('(no log lines)');
  return r.lines
    .flatMap((l, i) =>
      i === r.anchor
        ? [`${pc.cyan('>')} ${formatLogLine(l)}`]
        : opts.runtime || l.level !== 'system'
          ? [`  ${formatLogLine(l)}`]
          : [],
    )
    .join('\n');
}

/** A Logs Insights result as a table, with what the query read. */
export function formatInsights(r: InsightsResponse): string {
  const stats = pc.dim(
    `${r.recordsMatched} matched, ${r.recordsScanned} scanned (${formatBytes(r.bytesScanned)})`,
  );
  if (r.rows.length === 0) return `${pc.dim('(no results)')}\n${stats}`;
  const rows = r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i] ?? ''])));
  return `${table(rows, [...r.columns])}\n${stats}`;
}

export function formatBytes(n: number): string {
  if (n < 1_000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)} kB`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${(n / 1_000_000_000).toFixed(2)} GB`;
}

/** The trace list: when each started, what it was, how it ended and whether its calls were recorded. */
export function formatTraceList(r: TracesResponse): string {
  if (r.traces.length === 0) return pc.dim('(no traces)');
  const lines = [
    table(
      r.traces.map((t) => ({
        started: shortTime(t.ts),
        what: t.name,
        status:
          t.kind === 'req'
            ? (t.failed ? pc.red : (t.status ?? 0) >= 400 ? pc.yellow : pc.green)(String(t.status ?? ''))
            : t.failed
              ? pc.red('error')
              : 'ok',
        took: formatDuration(t.dur),
        calls: t.recorded
          ? `recorded${t.calls ? ` (+${t.calls} not)` : ''}`
          : t.calls
            ? pc.dim(`${t.calls} not recorded`)
            : '',
        trace: t.trace,
      })),
    ),
  ];
  if (r.truncated) lines.push(pc.dim('more traces matched; narrow --since or the filters to see them'));
  return lines.join('\n');
}

/** One error group: what, where, how often, and its sample. */
export function formatErrorGroup(g: ErrorGroup): string {
  const rows: Array<[string, string]> = [
    ['status', g.status === 'open' ? pc.red('open') : g.status],
    ['count', String(g.count)],
    ['first', shortTime(g.firstSeen)],
    ['last', shortTime(g.lastSeen)],
    ['source', g.source],
  ];
  if (g.sample.route) rows.push(['route', g.sample.route]);
  if (g.sample.job) rows.push(['job', g.sample.job]);
  if (g.sample.rev) rows.push(['rev', g.sample.rev]);
  if (g.sample.trace) rows.push(['trace', g.sample.trace]);
  return [
    pc.bold(`${g.name}: ${g.message}`),
    ...rows.map(([k, v]) => `  ${k.padEnd(7)}${v}`),
    ...(g.sample.stack ? ['', pc.dim(g.sample.stack)] : []),
  ].join('\n');
}

/** An error group's occurrences over time and by deployment. */
export function formatOccurrences(r: ErrorOccurrencesResponse, since: string): string {
  const total = r.counts.reduce((a, n) => a + n, 0);
  const lines = [
    `${total} in the last ${since} ${pc.dim(`(${r.res} buckets)`)}  ${pc.red(sparkline([...r.counts]))}`,
  ];
  if (r.revs.length) lines.push('', table(r.revs.map((v) => ({ deployment: v.value, count: v.count }))));
  return lines.join('\n');
}
