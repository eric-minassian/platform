/**
 * The explorer's query model. The control plane answers it (the series
 * endpoint) and evaluates alert rules with it; the console builds charts and
 * alert rules from it; the CLI sends it.
 *
 * Every metric is read from the rollups the telemetry processor writes
 * (`telemetryKeys`), except `realtime` and `service`, which come from
 * CloudWatch on demand and so can't be watched by alert rules. Neither can
 * `page_views` and `edge_requests`: the router's access log they come from
 * arrives up to an hour late.
 */
import { Schema } from 'effect';

const optional = Schema.optional;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Bucket sizes a query can ask for. `1m`, `1h` and `1d` are stored; the
 * others are sums of 1-minute rollups (latency histograms add), so they
 * reach back only as far as minute rollups are kept.
 */
export const QueryResolution = Schema.Literals(['1m', '5m', '10m', '15m', '30m', '1h', '1d']);
export type QueryResolution = typeof QueryResolution.Type;

export const QUERY_RESOLUTION_MS: Record<QueryResolution, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '10m': 600_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
};

/** About this many buckets per chart when the caller doesn't pick a resolution. */
export const TARGET_POINTS = 150;

/**
 * The smallest resolution that keeps `from`..`to` near `TARGET_POINTS`
 * buckets, given how far back minute rollups reach (`minuteHorizonMs` before
 * `now`): a range starting before that horizon can't be built from 1-minute
 * rows, so it uses hours (or days past 14 days).
 */
export function autoQueryResolution(
  from: number,
  to: number,
  now: number,
  minuteHorizonMs: number,
): QueryResolution {
  const span = Math.max(to - from, 60_000);
  const minuteOk = from >= now - minuteHorizonMs;
  const ladder: readonly QueryResolution[] = minuteOk
    ? ['1m', '5m', '10m', '15m', '30m', '1h', '1d']
    : ['1h', '1d'];
  for (const res of ladder) if (span / QUERY_RESOLUTION_MS[res] <= TARGET_POINTS * 1.5) return res;
  return '1d';
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * What a query measures:
 * - `requests`: HTTP requests (stage-wide, or of routes) the stage's server handled
 * - `page_views`: pages the router served for the stage's host (`isPageView`)
 * - `edge_requests`: every request the router served for it: files, server, stores
 * - `latency`: their duration
 * - `cold_starts`: requests served by a fresh server process
 * - `jobs`: queue, event, cron, invoke and service runs
 * - `job_duration`: their duration
 * - `custom`: the app's `Metrics.count`/`value` series
 * - `rate_limit`: `RateLimits` checks
 * - `realtime`: AppSync Events activity (CloudWatch)
 * - `service`: long-running services' CPU and memory (CloudWatch)
 */
export const SeriesMetric = Schema.Literals([
  'requests',
  'page_views',
  'edge_requests',
  'latency',
  'cold_starts',
  'jobs',
  'job_duration',
  'custom',
  'rate_limit',
  'realtime',
  'service',
]);
export type SeriesMetric = typeof SeriesMetric.Type;

/**
 * How each bucket is summarized:
 * - `count`: how many (requests, runs, checks, recorded values)
 * - `rate`: `count` per second
 * - `percent`: the share, 0–100, of the metric's events that match the
 *   status or outcome filter, among all of them in the bucket (5xx % of
 *   requests, failed % of runs, denied % of checks)
 * - `sum`, `avg`, `max`: of recorded values (custom metrics, realtime, service)
 * - `p50`…`p99`: latency percentiles, from the rollups' fixed-bucket histograms
 *   (each is the upper bound of the bucket holding it)
 * - `histogram`: every latency bucket's count, for heatmaps
 */
export const SeriesStat = Schema.Literals([
  'count',
  'rate',
  'percent',
  'sum',
  'avg',
  'max',
  'p50',
  'p90',
  'p95',
  'p99',
  'histogram',
]);
export type SeriesStat = typeof SeriesStat.Type;

export const StatusClass = Schema.Literals(['2xx', '3xx', '4xx', '5xx']);
export type StatusClass = typeof StatusClass.Type;
export const STATUS_CLASSES: readonly StatusClass[] = ['2xx', '3xx', '4xx', '5xx'];

/** Splits a query into one line per value of this dimension. */
export const SeriesGroupBy = Schema.Literals(['status', 'route', 'job', 'outcome', 'name']);
export type SeriesGroupBy = typeof SeriesGroupBy.Type;

export const SeriesOutcome = Schema.Literals(['ok', 'error', 'allowed', 'denied']);
export type SeriesOutcome = typeof SeriesOutcome.Type;

const nonEmpty = Schema.String.check(Schema.isNonEmpty());

export const SeriesFilter = Schema.Struct({
  /** Routes as rollups key them: `METHOD /pattern`, e.g. `GET /api/items/:id`. */
  routes: optional(Schema.Array(nonEmpty)),
  /** `requests` and `edge_requests` only. */
  status: optional(Schema.Array(StatusClass)),
  /** Jobs as `kind:name`, e.g. `queue:refresh`, `cron:digest`. */
  jobs: optional(Schema.Array(nonEmpty)),
  /** Custom metric names, rate limit names, or service names. */
  names: optional(Schema.Array(nonEmpty)),
  /** `jobs`: `ok` or `error`; `rate_limit`: `allowed` or `denied`. */
  outcome: optional(SeriesOutcome),
  /** `realtime`: `events`, `publishes`, `subscribes` or `errors`; `service`: `cpu` or `memory`. */
  measure: optional(nonEmpty),
});
export type SeriesFilter = typeof SeriesFilter.Type;

export const SeriesQuery = Schema.Struct({
  metric: SeriesMetric,
  stat: SeriesStat,
  filter: optional(SeriesFilter),
  groupBy: optional(SeriesGroupBy),
  /** Another stage than the page's. */
  stage: optional(nonEmpty),
});
export type SeriesQuery = typeof SeriesQuery.Type;

/** The statistics each metric answers; the first is its default. */
export const METRIC_STATS: Record<SeriesMetric, readonly SeriesStat[]> = {
  requests: ['count', 'rate', 'percent'],
  page_views: ['count', 'rate'],
  edge_requests: ['count', 'rate', 'percent'],
  latency: ['p95', 'p50', 'p90', 'p99', 'histogram'],
  cold_starts: ['count', 'percent'],
  jobs: ['count', 'rate', 'percent'],
  job_duration: ['p95', 'p50', 'p90', 'p99', 'histogram'],
  custom: ['sum', 'avg', 'count', 'max'],
  rate_limit: ['count', 'percent'],
  realtime: ['sum'],
  service: ['avg', 'max'],
};

/** The dimensions each metric can be grouped by. */
export const METRIC_GROUP_BY: Record<SeriesMetric, readonly SeriesGroupBy[]> = {
  requests: ['status', 'route'],
  page_views: [],
  edge_requests: ['status'],
  latency: ['route'],
  cold_starts: [],
  jobs: ['job', 'outcome'],
  job_duration: ['job'],
  custom: ['name'],
  rate_limit: ['name', 'outcome'],
  realtime: [],
  service: ['name'],
};

/** Metrics alert rules can watch: those read from rollups written as their events happen. */
export const ALERT_METRICS: readonly SeriesMetric[] = [
  'requests',
  'latency',
  'cold_starts',
  'jobs',
  'job_duration',
  'custom',
  'rate_limit',
];

export const REALTIME_MEASURES = ['events', 'publishes', 'subscribes', 'errors'] as const;
export const SERVICE_MEASURES = ['cpu', 'memory'] as const;

/**
 * Why a query can't be answered, or undefined when it can. `alert` also
 * refuses what an alert rule can't watch: CloudWatch metrics, histograms,
 * groups, and another stage than the rule's.
 */
export function checkSeriesQuery(
  q: SeriesQuery,
  options: { readonly alert?: boolean } = {},
): string | undefined {
  if (!METRIC_STATS[q.metric].includes(q.stat)) {
    return `${q.metric} answers ${METRIC_STATS[q.metric].join(', ')}, not ${q.stat}`;
  }
  if (q.groupBy && !METRIC_GROUP_BY[q.metric].includes(q.groupBy)) {
    const groups = METRIC_GROUP_BY[q.metric];
    return groups.length
      ? `${q.metric} can be grouped by ${groups.join(' or ')}, not ${q.groupBy}`
      : `${q.metric} can't be grouped`;
  }
  const f = q.filter ?? {};
  if (f.status?.length && q.metric !== 'requests' && q.metric !== 'edge_requests') {
    return 'only requests and edge requests filter by status';
  }
  if (f.routes?.length && q.metric !== 'requests' && q.metric !== 'latency' && q.metric !== 'cold_starts') {
    return 'only requests, latency and cold starts filter by route';
  }
  if (f.jobs?.length && q.metric !== 'jobs' && q.metric !== 'job_duration') return 'only jobs filter by job';
  if (f.outcome) {
    const allowed =
      q.metric === 'jobs' ? ['ok', 'error'] : q.metric === 'rate_limit' ? ['allowed', 'denied'] : [];
    if (!allowed.includes(f.outcome)) {
      return allowed.length
        ? `${q.metric} outcomes are ${allowed.join(' or ')}`
        : `${q.metric} doesn't filter by outcome`;
    }
  }
  if (f.names?.length && q.metric !== 'custom' && q.metric !== 'rate_limit' && q.metric !== 'service') {
    return 'only custom metrics, rate limits and services filter by name';
  }
  if (q.metric === 'custom' && !f.names?.length && q.groupBy !== 'name') {
    return 'a custom metric query names its metric, or groups by name';
  }
  if (q.metric === 'realtime' && !REALTIME_MEASURES.some((m) => m === f.measure)) {
    return `realtime measures one of ${REALTIME_MEASURES.join(', ')}`;
  }
  if (q.metric === 'service' && !SERVICE_MEASURES.some((m) => m === f.measure)) {
    return `service measures ${SERVICE_MEASURES.join(' or ')}`;
  }
  if (q.metric !== 'realtime' && q.metric !== 'service' && f.measure) {
    return 'only realtime and service queries take a measure';
  }
  if (options.alert) {
    if (!ALERT_METRICS.includes(q.metric)) return `alert rules can't watch ${q.metric}`;
    if (q.stat === 'histogram') return 'alert rules watch one number, not a histogram';
    if (q.groupBy) return 'alert rules watch one series; filter instead of grouping';
    if (q.stage) return "an alert rule's query reads the rule's own stage";
  }
  return undefined;
}

/** The unit a query's values are in (a custom metric's own unit comes with its series). */
const STAT_UNIT: Record<SeriesStat, string> = {
  count: 'count',
  rate: 'per_second',
  percent: 'percent',
  sum: 'count',
  avg: 'count',
  max: 'count',
  p50: 'ms',
  p90: 'ms',
  p95: 'ms',
  p99: 'ms',
  histogram: 'ms',
};

export function seriesUnit(q: Pick<SeriesQuery, 'metric' | 'stat' | 'filter'>): string {
  const unit = STAT_UNIT[q.stat];
  // Service CPU and memory are percentages of what the task reserved.
  return unit === 'count' && q.metric === 'service' ? 'percent' : unit;
}

const METRIC_NOUN: Record<SeriesMetric, string> = {
  requests: 'requests',
  page_views: 'page views',
  edge_requests: 'edge requests',
  latency: 'latency',
  cold_starts: 'cold starts',
  jobs: 'job runs',
  job_duration: 'job duration',
  custom: 'custom metric',
  rate_limit: 'rate limit checks',
  realtime: 'realtime',
  service: 'service',
};

/**
 * A short label for a query, as charts, alert emails and the CLI show it:
 * `5xx % of requests`, `p95 latency of GET /api/x`, `failed % of job runs`.
 */
export function describeQuery(q: SeriesQuery): string {
  const f = q.filter ?? {};
  const noun = METRIC_NOUN[q.metric];
  const scope = [
    f.routes?.length ? (f.routes.length === 1 ? f.routes[0] : `${f.routes.length} routes`) : undefined,
    f.jobs?.length ? (f.jobs.length === 1 ? f.jobs[0] : `${f.jobs.length} jobs`) : undefined,
  ].filter(Boolean);
  const of = scope.length ? ` of ${scope.join(', ')}` : '';
  const by = q.groupBy ? ` by ${q.groupBy}` : '';
  const where = q.stage ? ` (${q.stage})` : '';
  const subset = f.status?.length
    ? f.status.join('+')
    : f.outcome === 'error'
      ? 'failed'
      : f.outcome
        ? f.outcome
        : undefined;
  const generic = (): string => {
    if (q.stat === 'percent') return `${subset ?? 'all'} % of ${noun}`;
    if (q.stat === 'rate') return `${subset ? `${subset} ` : ''}${noun} per second`;
    if (q.stat === 'count') return `${subset ? `${subset} ` : ''}${noun}`;
    if (q.stat === 'histogram') return `${noun} distribution`;
    return `${q.stat} ${noun}`;
  };
  let head: string;
  switch (q.metric) {
    case 'custom':
      head = `${q.stat} of ${f.names?.length ? f.names.join(', ') : 'custom metrics'}`;
      break;
    case 'realtime':
      head = `realtime ${f.measure ?? 'events'}`;
      break;
    case 'service':
      head = `${q.stat} ${f.measure ?? 'cpu'}${f.names?.length ? ` of ${f.names.join(', ')}` : ''}`;
      break;
    case 'rate_limit':
      head =
        q.stat === 'percent'
          ? `${subset ?? 'denied'} % of rate limit checks`
          : `${subset ? `${subset} ` : ''}rate limit checks`;
      if (f.names?.length) head += ` (${f.names.join(', ')})`;
      break;
    case 'requests':
    case 'page_views':
    case 'edge_requests':
    case 'latency':
    case 'cold_starts':
    case 'jobs':
    case 'job_duration':
      head = generic();
      break;
  }
  return `${head}${of}${by}${where}`;
}

// ---------------------------------------------------------------------------
// Charts and filters
// ---------------------------------------------------------------------------

/** A query of an explorer chart, with the id expressions refer to it by (`a`, `b`, …). */
export const NamedSeriesQuery = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{0,7}$/)),
  ...SeriesQuery.fields,
  label: optional(Schema.String),
  /** Charted only through expressions. */
  hidden: optional(Schema.Boolean),
});
export type NamedSeriesQuery = typeof NamedSeriesQuery.Type;

/** Arithmetic over other queries' values in the same bucket, e.g. `100 * a / b` (evaluated by the console). */
export const SeriesExpression = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{0,7}$/)),
  expr: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  label: optional(Schema.String),
  hidden: optional(Schema.Boolean),
});
export type SeriesExpression = typeof SeriesExpression.Type;

export const ChartKind = Schema.Literals(['line', 'area', 'bar', 'heatmap']);
export type ChartKind = typeof ChartKind.Type;

export const MetricsView = Schema.Struct({
  kind: Schema.Literal('metrics'),
  queries: Schema.Array(NamedSeriesQuery).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  expressions: optional(Schema.Array(SeriesExpression).check(Schema.isMaxLength(8))),
  chart: ChartKind,
  scale: optional(Schema.Literals(['linear', 'log'])),
  /** A line drawn across the chart, e.g. an alert threshold. */
  threshold: optional(Schema.Finite),
});
export type MetricsView = typeof MetricsView.Type;

export const LogLevelName = Schema.Literals(['error', 'warn', 'info', 'debug', 'system']);
export type LogLevelName = typeof LogLevelName.Type;

/**
 * Structured log filters. Any of them makes a search run on Logs Insights
 * (CloudWatch filter patterns can't combine text with JSON fields).
 */
export const LogFilters = Schema.Struct({
  levels: optional(Schema.Array(LogLevelName)),
  /** `web`, `worker` or `service:<name>`. */
  streams: optional(Schema.Array(nonEmpty)),
  /** Route patterns (without the method), e.g. `/api/items/:id`. */
  routes: optional(Schema.Array(nonEmpty)),
  status: optional(Schema.Array(StatusClass)),
  /** Deployment ids. */
  revs: optional(Schema.Array(nonEmpty)),
  trace: optional(nonEmpty),
});
export type LogFilters = typeof LogFilters.Type;

export const TraceFilters = Schema.Struct({
  kind: optional(Schema.Literals(['req', 'job'])),
  /** `METHOD /pattern`. */
  routes: optional(Schema.Array(nonEmpty)),
  /** `kind:name`. */
  jobs: optional(Schema.Array(nonEmpty)),
  /** `error`: 5xx requests and failed jobs; `ok`: the rest. */
  outcome: optional(Schema.Literals(['ok', 'error'])),
  minMs: optional(Schema.Finite),
  /** Only traces whose spans were written (failed, slow or sampled). */
  recorded: optional(Schema.Boolean),
});
export type TraceFilters = typeof TraceFilters.Type;

// ---------------------------------------------------------------------------
// Alert rules
// ---------------------------------------------------------------------------

export const AlertState = Schema.Literals(['ok', 'alarm', 'no_data']);
export type AlertState = typeof AlertState.Type;

/** Minutes an alert rule's window can cover. */
export const ALERT_WINDOWS = [1, 5, 10, 15, 30, 60] as const;
/** How long the evaluator waits for a minute's telemetry to arrive before reading it. */
export const ALERT_LAG_MINUTES = 2;
export const MAX_ALERT_RULES_PER_APP = 25;
/** How long alert state changes are kept. */
export const ALERT_HISTORY_DAYS = 90;

const name = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(80));

export const AlertCondition = Schema.Struct({
  op: Schema.Literals(['above', 'below']),
  threshold: Schema.Finite,
  /** The query is summarized over the last this many minutes (sums, shares and histograms of the window). */
  minutes: Schema.Literals(ALERT_WINDOWS),
});
export type AlertCondition = typeof AlertCondition.Type;

/**
 * A window with no data (no requests behind a percentage or percentile, no
 * values of a custom metric): `ok` and `alarm` treat it as that state,
 * `keep` keeps the current one. Counts are never missing: no events is 0.
 */
export const AlertMissingData = Schema.Literals(['ok', 'alarm', 'keep']);
export type AlertMissingData = typeof AlertMissingData.Type;

export const AlertRuleInput = Schema.Struct({
  name,
  stage: nonEmpty,
  query: SeriesQuery,
  condition: AlertCondition,
  missing: AlertMissingData,
  /** Email the platform's alerts topic when the rule fires and when it recovers. */
  notify: Schema.Boolean,
  enabled: Schema.Boolean,
});
export type AlertRuleInput = typeof AlertRuleInput.Type;

export const AlertRule = Schema.Struct({
  id: Schema.String,
  app: Schema.String,
  ...AlertRuleInput.fields,
  state: AlertState,
  /** When `state` last changed. */
  stateSince: optional(Schema.String),
  /** The window's value at the last evaluation (null: no data). */
  value: optional(Schema.NullOr(Schema.Finite)),
  evaluatedAt: optional(Schema.String),
  createdBy: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type AlertRule = typeof AlertRule.Type;

export const AlertEvent = Schema.Struct({
  ts: Schema.String,
  rule: Schema.String,
  name: Schema.String,
  stage: Schema.String,
  from: AlertState,
  to: AlertState,
  value: Schema.NullOr(Schema.Finite),
  threshold: Schema.Finite,
});
export type AlertEvent = typeof AlertEvent.Type;

export const AlertHistoryResponse = Schema.Struct({ events: Schema.Array(AlertEvent) });
export type AlertHistoryResponse = typeof AlertHistoryResponse.Type;

export const breaches = (value: number, c: Pick<AlertCondition, 'op' | 'threshold'>): boolean =>
  c.op === 'above' ? value > c.threshold : value < c.threshold;

/** The state a rule moves to given its window's value (null: no data). */
export function nextAlertState(
  current: AlertState,
  value: number | null,
  rule: { readonly condition: AlertCondition; readonly missing: AlertMissingData },
): AlertState {
  if (value === null) {
    if (rule.missing === 'ok') return 'ok';
    if (rule.missing === 'alarm') return 'alarm';
    return current === 'alarm' || current === 'ok' ? current : 'no_data';
  }
  return breaches(value, rule.condition) ? 'alarm' : 'ok';
}
