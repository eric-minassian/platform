/**
 * The Logs Insights queries behind log search with structured filters, log
 * stats, trace lists and error occurrences, and the guard on members' own
 * queries. Pure, so every query string and its escaping is tested without AWS.
 *
 * Queries read the JSON fields Logs Insights discovers in a line: SDK lines
 * are one JSON object each (`_p`, `t`, `route`, `status`, `rev`, `trace`…),
 * and so are the Lambda runtime's records (`type: platform.*`). User values
 * reach a query only as a validated string literal (`str`) or an escaped
 * regex (`literalRegex`).
 */
import {
  type ErrorOccurrencesResponse,
  type FacetCount,
  fingerprint,
  type LogFilters,
  type LogLevelName,
  type LogLine,
  type LogStatsResponse,
  QUERY_RESOLUTION_MS,
  type QueryResolution,
  type StatusClass,
  type TelemetryEvent,
  type TraceFilters,
  type TraceSummary,
} from '@ericminassian/platform-core';
import { absurd, Schema } from 'effect';

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** What can't appear in a string literal: quotes, backslashes, control characters and line breaks. */
const UNQUOTABLE = /["\\\p{Cc}\u2028\u2029]/u;

/**
 * A string literal for a value that was validated first. Logs Insights'
 * escaping inside quotes isn't specified, so nothing that would need it gets
 * this far: a value that does is a bug in its validation.
 */
export function str(value: string): string {
  if (UNQUOTABLE.test(value)) throw new Error(`unquotable query value ${JSON.stringify(value)}`);
  return `"${value}"`;
}

const list = (values: ReadonlyArray<string>) => `[${values.map(str).join(', ')}]`;

/**
 * A regex literal that matches `text` as is: ASCII punctuation (the
 * delimiter `/`, `\`, quotes, `|`, metacharacters) is backslash-escaped, and
 * control characters are written as `\x{…}`, so the text can't end the
 * literal or the command. (`_` stays as is: it means itself, and some RE2
 * versions refuse `\_`.)
 */
export function literalRegex(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (/[A-Za-z0-9 _]/.test(ch) || (code > 0x7f && !UNQUOTABLE.test(ch))) out += ch;
    else if (code > 0x20 && code < 0x7f) out += `\\${ch}`;
    else out += `\\x{${code.toString(16)}}`;
  }
  return `/${out}/`;
}

/** A finite number as a query literal (no exponent notation). */
const num = (n: number) => String(Math.round(Math.min(Math.max(n, -1e12), 1e15) * 1000) / 1000);

/** Trace ids as the trace view accepts them (hex, with dashes). */
export const TRACE_ID_PATTERN = /^[0-9a-f-]{8,64}$/i;
/** Deployment ids, and `unknown` for lines written without one. */
const REV_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Error group fingerprints (`fingerprint()` in core: 8 hex digits). */
export const FINGERPRINT_PATTERN = /^[0-9a-f]{8}$/;

const routeProblem = (route: string): string | undefined =>
  !route.startsWith('/') || route.length > 300 || UNQUOTABLE.test(route)
    ? `route ${JSON.stringify(route)} must be a path pattern like /api/items/:id`
    : undefined;

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

const TELEMETRY = '`_p` = 1';

/**
 * The level the console shows a telemetry line at (`toLogLine`): a `log`
 * line's own, `error` for `err` lines and 5xx requests, `info` for the rest.
 * `LEVEL_CONDITIONS` is the same rule as a query.
 */
export function telemetryLevel(e: TelemetryEvent): Exclude<LogLevelName, 'system'> {
  switch (e.t) {
    case 'log':
      return e.level;
    case 'err':
      return 'error';
    case 'req':
      return e.status >= 500 ? 'error' : 'info';
    case 'job':
    case 'span':
    case 'metric':
    case 'limit':
    case 'env':
      return 'info';
    default:
      return absurd(e);
  }
}

/**
 * Selects the lines `toLogLine` labels with each level:
 * - `system`: the Lambda runtime's records (JSON with `type` `platform.*`
 *   that isn't an SDK line);
 * - `error`: `log` lines at error, `err` lines, requests answered 5xx;
 * - `warn`, `debug`: `log` lines at that level;
 * - `info`: `log` lines at info, requests answered below 500, and every
 *   `job`, `span`, `metric`, `limit` and `env` line (a failed job's `err`
 *   line is its error).
 * Other lines (plain text, other JSON) have no level, and no level selects them.
 */
export const LEVEL_CONDITIONS: Record<LogLevelName, string> = {
  system: '(type like /^platform\\./ and not ispresent(`_p`))',
  error: `(${TELEMETRY} and ((t = "log" and level = "error") or t = "err" or (t = "req" and status >= 500)))`,
  warn: `(${TELEMETRY} and t = "log" and level = "warn")`,
  info: `(${TELEMETRY} and ((t = "log" and level = "info") or (t = "req" and status < 500) or t in ["job", "span", "metric", "limit", "env"]))`,
  debug: `(${TELEMETRY} and t = "log" and level = "debug")`,
};

export const LOG_LEVELS: ReadonlyArray<LogLevelName> = ['error', 'warn', 'info', 'debug', 'system'];

/** The fields the stats query groups lines by to tell their level (`statsQueries`). */
export interface LevelRow {
  /** `_p`, or 0. */
  readonly tele: string;
  /** `t`, or empty. */
  readonly tkind: string;
  /** `level`, or empty. */
  readonly tlevel: string;
  /** `floor(status / 100)`, or 0. */
  readonly sclass: string;
  /** The start of `type`, or empty. */
  readonly rtype: string;
}

/** `LEVEL_CONDITIONS` over one group of the stats query. */
export function levelOfRow(r: LevelRow): LogLevelName | undefined {
  // `platform.` (or `platform`, should `substr` count from 1): only the runtime's records have one.
  if (r.tele !== '1') return r.rtype.startsWith('platform') ? 'system' : undefined;
  switch (r.tkind) {
    case 'log':
      return r.tlevel === 'error' || r.tlevel === 'warn' || r.tlevel === 'info' || r.tlevel === 'debug'
        ? r.tlevel
        : undefined;
    case 'err':
      return 'error';
    case 'req':
      return Number(r.sclass) >= 5 ? 'error' : 'info';
    case 'job':
    case 'span':
    case 'metric':
    case 'limit':
    case 'env':
      return 'info';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Log filters
// ---------------------------------------------------------------------------

/** Whether the filters need Logs Insights: `streams` only picks log groups, which a filter pattern search does too. */
export function hasStructuredFilters(f: LogFilters | undefined): boolean {
  return Boolean(f?.levels?.length || f?.routes?.length || f?.status?.length || f?.revs?.length || f?.trace);
}

/** Why the filters can't be queried, or undefined. Stream names are checked against the stage's log groups. */
export function checkLogFilters(f: LogFilters | undefined): string | undefined {
  for (const route of f?.routes ?? []) {
    const problem = routeProblem(route);
    if (problem) return problem;
  }
  for (const rev of f?.revs ?? []) {
    if (!REV_PATTERN.test(rev)) return `rev ${JSON.stringify(rev)} isn't a deployment id`;
  }
  if (f?.trace !== undefined && !TRACE_ID_PATTERN.test(f.trace)) return 'invalid trace id';
  return undefined;
}

const statusRange = (c: StatusClass) => {
  const n = Number(c[0]) * 100;
  return `(status >= ${n} and status < ${n + 100})`;
};

/** One condition per structured filter (all of them must hold). */
export function filterConditions(f: LogFilters | undefined): string[] {
  const conds: string[] = [];
  if (f?.levels?.length)
    conds.push(`(${[...new Set(f.levels)].map((l) => LEVEL_CONDITIONS[l]).join(' or ')})`);
  if (f?.routes?.length) conds.push(`route in ${list([...new Set(f.routes)])}`);
  if (f?.status?.length) conds.push(`(${[...new Set(f.status)].map(statusRange).join(' or ')})`);
  if (f?.revs?.length) conds.push(`rev in ${list([...new Set(f.revs)])}`);
  if (f?.trace) conds.push(`trace = ${str(f.trace)}`);
  return conds;
}

/** Whether a live line passes the filters: `filterConditions` (and `streams`) over a mapped line. */
export function matchesLogFilters(line: LogLine, f: LogFilters | undefined): boolean {
  if (!f) return true;
  const e: Readonly<Record<string, unknown>> = line.event ?? {};
  if (f.streams?.length && !f.streams.includes(line.stream)) return false;
  if (f.levels?.length && !f.levels.some((l) => l === line.level)) return false;
  if (f.routes?.length && !(typeof e.route === 'string' && f.routes.includes(e.route))) return false;
  if (f.status?.length) {
    const status = e.status;
    if (typeof status !== 'number' || !f.status.some((c) => Math.floor(status / 100) === Number(c[0])))
      return false;
  }
  if (f.revs?.length && !(typeof e.rev === 'string' && f.revs.includes(e.rev))) return false;
  if (f.trace && line.trace !== f.trace) return false;
  return true;
}

/**
 * The search text as terms every line must contain: plain text is one term
 * (as a filter pattern search reads it), and quoted terms (`"a" "b"`) are
 * one each. The other filter patterns can't run on Logs Insights.
 */
export function searchTerms(
  q: string | undefined,
): { readonly terms: string[] } | { readonly error: string } {
  const s = q?.trim() ?? '';
  if (!s) return { terms: [] };
  if (s.startsWith('{') || s.startsWith('?')) {
    return { error: 'a filter pattern can’t be combined with structured filters; search for plain text' };
  }
  if (!s.startsWith('"')) return { terms: [s] };
  const terms: string[] = [];
  const quoted = /\s*"((?:[^"\\]|\\.)*)"\s*/y;
  let m: RegExpExecArray | null;
  while ((m = quoted.exec(s))) {
    terms.push(m[1]!.replace(/\\(.)/g, '$1'));
    if (quoted.lastIndex === s.length) return { terms };
  }
  return { error: 'quote each search term, or search for plain text' };
}

const timeBounds = (from: number, to: number) =>
  `toMillis(@timestamp) >= ${Math.floor(from)} and toMillis(@timestamp) <= ${Math.ceil(to)}`;

/** The search's conditions: its time bounds, the structured filters and the text. */
const searchFilter = (o: {
  filters?: LogFilters | undefined;
  terms: ReadonlyArray<string>;
  from: number;
  to: number;
}) =>
  [
    timeBounds(o.from, o.to),
    ...filterConditions(o.filters),
    ...o.terms.map((t) => `@message like ${literalRegex(t)}`),
  ].join(' and ');

/** Lines of a filtered search, newest first; `to` is the page's upper bound (`InsightsCursor`). */
export function searchQuery(o: {
  readonly filters?: LogFilters | undefined;
  readonly terms: ReadonlyArray<string>;
  readonly from: number;
  readonly to: number;
  readonly limit: number;
}): string {
  return [
    `filter ${searchFilter(o)}`,
    'fields @timestamp, @message, @log, @logStream',
    'sort @timestamp desc',
    `limit ${Math.min(Math.max(1, Math.floor(o.limit)), 10_000)}`,
  ].join('\n| ');
}

/** Logs Insights `bin()` periods use the same units as the explorer's resolutions. */
export const insightsBin = (res: QueryResolution) => `bin(${res})`;

/**
 * The stats queries of a search: lines per bucket grouped by what decides
 * their level (`levelOfRow`), and counts by log group, route, status class
 * and deployment.
 */
export function statsQueries(o: {
  readonly filters?: LogFilters | undefined;
  readonly terms: ReadonlyArray<string>;
  readonly from: number;
  readonly to: number;
  readonly res: QueryResolution;
}): {
  readonly levels: string;
  readonly streams: string;
  readonly routes: string;
  readonly status: string;
  readonly revs: string;
} {
  const where = `filter ${searchFilter(o)}`;
  return {
    levels: [
      where,
      'fields coalesce(`_p`, 0) as tele, coalesce(t, "") as tkind, coalesce(level, "") as tlevel, coalesce(floor(status / 100), 0) as sclass, coalesce(substr(type, 0, 9), "") as rtype',
      `stats count(*) as n by ${insightsBin(o.res)} as bucket, tele, tkind, tlevel, sclass, rtype`,
    ].join('\n| '),
    streams: [where, 'stats count(*) as n by @log'].join('\n| '),
    routes: [
      where,
      'filter ispresent(route)',
      'stats count(*) as n by route',
      'sort n desc',
      'limit 10',
    ].join('\n| '),
    status: [
      where,
      'filter status >= 200 and status < 600',
      'fields floor(status / 100) as sclass',
      'stats count(*) as n by sclass',
    ].join('\n| '),
    revs: [where, 'filter ispresent(rev)', 'stats count(*) as n by rev', 'sort n desc', 'limit 10'].join(
      '\n| ',
    ),
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** One result row by field name. */
export type Row = Readonly<Record<string, string>>;

/** Logs Insights writes times as `2026-11-16 16:30:00.123` (UTC); epoch ms, NaN when it isn't one. */
export function insightsTime(value: string | undefined): number {
  return value ? Date.parse(`${value.trim().replace(' ', 'T')}Z`) : Number.NaN;
}

/** Bucket start times from `from`'s bucket to `to`'s, as the series endpoints count them. */
export function bucketTimes(from: number, to: number, res: QueryResolution): number[] {
  const step = QUERY_RESOLUTION_MS[res];
  const out: number[] = [];
  for (let t = Math.floor(from / step) * step; t <= to && out.length < 2_000; t += step) out.push(t);
  return out;
}

/** The index of the bucket a `bucket` (`bin()`) value falls in, if it is one of `times`. */
const bucketIndex = (times: ReadonlyArray<number>, res: QueryResolution) => {
  const step = QUERY_RESOLUTION_MS[res];
  const index = new Map(times.map((t, i) => [t, i]));
  return (bucket: string | undefined) => index.get(Math.floor(insightsTime(bucket) / step) * step);
};

const count = (r: Row) => Number(r.n) || 0;

/** The commonest values first, at most `max`, without empty ones. */
export function topValues(counts: ReadonlyMap<string, number>, max = 10): FacetCount[] {
  return [...counts]
    .filter(([value, n]) => value !== '' && n > 0)
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([value, n]) => ({ value, count: n }));
}

const tally = (rows: ReadonlyArray<Row>, key: (r: Row) => string | undefined) => {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + count(r));
  }
  return counts;
};

/** A search's stats from the rows of its `statsQueries`; `streamOf` names a log group's stream. */
export function logStatsOf(o: {
  readonly res: QueryResolution;
  readonly from: number;
  readonly to: number;
  readonly levels: ReadonlyArray<Row>;
  readonly streams: ReadonlyArray<Row>;
  readonly routes: ReadonlyArray<Row>;
  readonly status: ReadonlyArray<Row>;
  readonly revs: ReadonlyArray<Row>;
  readonly streamOf: (logGroup: string) => string;
}): LogStatsResponse {
  const times = bucketTimes(o.from, o.to, o.res);
  const indexOf = bucketIndex(times, o.res);
  const levels = {
    error: times.map(() => 0),
    warn: times.map(() => 0),
    info: times.map(() => 0),
    debug: times.map(() => 0),
    system: times.map(() => 0),
  };
  const perLevel = new Map<string, number>();
  let total = 0;
  for (const r of o.levels) {
    const n = count(r);
    total += n;
    const level = levelOfRow({
      tele: r.tele ?? '',
      tkind: r.tkind ?? '',
      tlevel: r.tlevel ?? '',
      sclass: r.sclass ?? '',
      rtype: r.rtype ?? '',
    });
    if (!level) continue;
    perLevel.set(level, (perLevel.get(level) ?? 0) + n);
    const i = indexOf(r.bucket);
    if (i !== undefined) levels[level][i]! += n;
  }
  const sclass = (r: Row) => {
    const c = Number(r.sclass);
    return c >= 2 && c <= 5 ? `${c}xx` : undefined;
  };
  return {
    res: o.res,
    timestamps: times.map((t) => new Date(t).toISOString()),
    levels,
    total,
    facets: {
      level: topValues(perLevel),
      stream: topValues(tally(o.streams, (r) => (r['@log'] ? o.streamOf(r['@log']) : undefined))),
      route: topValues(tally(o.routes, (r) => r.route)),
      status: topValues(tally(o.status, sclass)),
      rev: topValues(tally(o.revs, (r) => r.rev)),
    },
  };
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/**
 * Where a filtered search's next page starts (`next`, as base64url JSON):
 * `b` is the oldest line's timestamp (epoch ms), `s` the keys (`rowKey`) of
 * the lines at `b` already returned. The next page reads lines at or before
 * `b` and drops those, so lines that share a millisecond across pages are
 * neither repeated nor skipped.
 */
export const InsightsCursor = Schema.Struct({ b: Schema.Finite, s: Schema.Array(Schema.String) });
export type InsightsCursor = typeof InsightsCursor.Type;

const CursorJson = Schema.fromJsonString(InsightsCursor);
export const encodeInsightsCursor = (c: InsightsCursor): string =>
  Buffer.from(JSON.stringify(c)).toString('base64url');
export const decodeInsightsCursor = (token: string) =>
  Schema.decodeEffect(CursorJson)(Buffer.from(token, 'base64url').toString());

/** A line's identity within a millisecond: its log group, log stream and text. */
export const rowKey = (log: string, logStream: string, message: string) =>
  fingerprint([log, logStream, message]);

/** A result line of a filtered search. */
export interface SearchRow {
  readonly ts: number;
  readonly key: string;
}

/**
 * How many lines to ask for: the page, the lines at the boundary that will be
 * dropped, and one more to tell whether there are more.
 */
export const fetchCount = (limit: number, cursor: InsightsCursor | undefined) =>
  Math.min(limit + (cursor?.s.length ?? 0) + 1, 10_000);

/** One page of rows (newest first) after `cursor`, and the cursor after it. */
export function pageRows<R extends SearchRow>(
  rows: ReadonlyArray<R>,
  cursor: InsightsCursor | undefined,
  limit: number,
): { readonly rows: R[]; readonly next?: InsightsCursor } {
  const seen = new Map<string, number>();
  for (const k of cursor?.s ?? []) seen.set(k, (seen.get(k) ?? 0) + 1);
  const fresh = rows.filter((r) => {
    if (!cursor) return true;
    if (r.ts > cursor.b) return false;
    if (r.ts < cursor.b) return true;
    const left = seen.get(r.key) ?? 0;
    if (left === 0) return true;
    seen.set(r.key, left - 1);
    return false;
  });
  const page = fresh.slice(0, limit);
  const last = page.at(-1);
  if (fresh.length <= limit || !last) return { rows: page };
  const atBoundary = page.filter((r) => r.ts === last.ts).map((r) => r.key);
  return {
    rows: page,
    next: { b: last.ts, s: cursor?.b === last.ts ? [...cursor.s, ...atBoundary] : atBoundary },
  };
}

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

const JOB_KINDS = new Set(['queue', 'event', 'cron', 'invoke', 'service']);
const ROUTE_KEY = /^([A-Z]{1,16}) (\/.*)$/;

/** Why trace filters can't be queried, or undefined. */
export function checkTraceFilters(f: TraceFilters | undefined): string | undefined {
  for (const r of f?.routes ?? []) {
    const m = ROUTE_KEY.exec(r);
    if (!m) return `route ${JSON.stringify(r)} must be METHOD /pattern, e.g. GET /api/items/:id`;
    const problem = routeProblem(m[2]!);
    if (problem) return problem;
  }
  for (const j of f?.jobs ?? []) {
    const i = j.indexOf(':');
    const name = j.slice(i + 1);
    if (i < 0 || !JOB_KINDS.has(j.slice(0, i)) || !name || name.length > 200 || UNQUOTABLE.test(name)) {
      return `job ${JSON.stringify(j)} must be kind:name, e.g. queue:refresh`;
    }
  }
  if (f?.minMs !== undefined && f.minMs < 0) return 'minMs can’t be negative';
  return undefined;
}

/**
 * Root lines of traces: requests and jobs (`parent` is only ever on spans,
 * and a job continuing a request's trace is a root of its own hop), newest
 * first.
 *
 * `recorded` keeps lines that name their own `span` id: the SDK writes it
 * exactly when the request or job kept its spans (it failed, took
 * `SLOW_TRACE_MS` or longer, logged an `err` line, or its trace is sampled;
 * `endRoot` in the SDK), and SDKs from before span sampling always wrote it
 * with every span.
 */
export function tracesQuery(o: {
  readonly filters?: TraceFilters | undefined;
  readonly from: number;
  readonly to: number;
  readonly limit: number;
}): string {
  const f = o.filters ?? {};
  const conds = [
    timeBounds(o.from, o.to),
    TELEMETRY,
    f.kind ? `t = ${str(f.kind)}` : 't in ["req", "job"]',
    'ispresent(trace)',
    'not ispresent(parent)',
  ];
  const which = [
    ...(f.routes ?? []).map((r) => {
      const [, method, route] = ROUTE_KEY.exec(r)!;
      return `(t = "req" and method = ${str(method!)} and route = ${str(route!)})`;
    }),
    ...(f.jobs ?? []).map((j) => {
      const i = j.indexOf(':');
      return `(t = "job" and kind = ${str(j.slice(0, i))} and name = ${str(j.slice(i + 1))})`;
    }),
  ];
  if (which.length) conds.push(`(${which.join(' or ')})`);
  if (f.outcome === 'error')
    conds.push('((t = "req" and status >= 500) or (t = "job" and status = "error"))');
  if (f.outcome === 'ok') conds.push('((t = "req" and status < 500) or (t = "job" and status = "ok"))');
  if (f.minMs !== undefined) conds.push(`dur >= ${num(f.minMs)}`);
  if (f.recorded) conds.push('ispresent(span)');
  return [
    `filter ${conds.join(' and ')}`,
    'fields @timestamp, @message',
    'sort @timestamp desc',
    `limit ${Math.min(Math.max(1, Math.floor(o.limit)), 10_000)}`,
  ].join('\n| ');
}

/** A trace list's row for a root line; undefined for any other line. */
export function traceSummary(e: TelemetryEvent): TraceSummary | undefined {
  if ((e.t !== 'req' && e.t !== 'job') || !e.trace || e.parent) return undefined;
  const common = {
    trace: e.trace,
    ts: new Date(Math.round(e.ts - e.dur)).toISOString(),
    dur: e.dur,
    recorded: e.span !== undefined,
    ...(e.calls ? { calls: e.calls } : {}),
    rev: e.rev,
  };
  return e.t === 'req'
    ? { ...common, kind: 'req', name: `${e.method} ${e.route}`, status: e.status, failed: e.status >= 500 }
    : { ...common, kind: 'job', name: `${e.kind} ${e.name}`, failed: e.status === 'error' };
}

// ---------------------------------------------------------------------------
// Error occurrences
// ---------------------------------------------------------------------------

/** An error group's `err` lines per bucket and per deployment. */
export function occurrencesQueries(o: {
  readonly fingerprint: string;
  readonly from: number;
  readonly to: number;
  readonly res: QueryResolution;
}): { readonly buckets: string; readonly revs: string } {
  if (!FINGERPRINT_PATTERN.test(o.fingerprint)) throw new Error(`invalid fingerprint ${o.fingerprint}`);
  const where = `filter ${timeBounds(o.from, o.to)} and ${TELEMETRY} and t = "err" and fingerprint = ${str(o.fingerprint)}`;
  return {
    buckets: [where, `stats count(*) as n by ${insightsBin(o.res)} as bucket`].join('\n| '),
    revs: [where, 'stats count(*) as n by rev', 'sort n desc', 'limit 50'].join('\n| '),
  };
}

/** An error group's occurrences from the rows of its `occurrencesQueries`. */
export function occurrencesOf(o: {
  readonly res: QueryResolution;
  readonly from: number;
  readonly to: number;
  readonly buckets: ReadonlyArray<Row>;
  readonly revs: ReadonlyArray<Row>;
}): ErrorOccurrencesResponse {
  const times = bucketTimes(o.from, o.to, o.res);
  const indexOf = bucketIndex(times, o.res);
  const counts = times.map(() => 0);
  for (const r of o.buckets) {
    const i = indexOf(r.bucket);
    if (i !== undefined) counts[i]! += count(r);
  }
  return {
    res: o.res,
    timestamps: times.map((t) => new Date(t).toISOString()),
    counts,
    revs: topValues(
      tally(o.revs, (r) => r.rev),
      50,
    ),
  };
}

// ---------------------------------------------------------------------------
// Members' own queries
// ---------------------------------------------------------------------------

/**
 * Why a member's own query can't run, or undefined. It runs on the stage's
 * log groups only (`logGroupNames`); the `SOURCE` command picks log groups in
 * the query instead, which would reach other apps' logs, so it is refused in
 * any command position and so is its `logGroups(…)` argument anywhere.
 * Matching uppercases first: `ſ` is an `S` to a case-insensitive parser.
 */
export function checkUserQuery(query: string): string | undefined {
  const upper = query.toUpperCase();
  if (/(^|[|\n\r;(])\s*SOURCE\b/.test(upper) || /\bLOGGROUPS\s*\(/.test(upper)) {
    return 'queries run on the stage’s own log groups: SOURCE isn’t allowed (quote a field named source as `source`)';
  }
  return undefined;
}

/** A finished query's results as columns (in the order fields first appear, without `@ptr`) and rows. */
export function resultTable(
  results: ReadonlyArray<
    ReadonlyArray<{ readonly field?: string | undefined; readonly value?: string | undefined }>
  >,
) {
  const columns: string[] = [];
  for (const row of results)
    for (const { field } of row)
      if (field && field !== '@ptr' && !columns.includes(field)) columns.push(field);
  const rows = results.map((row) => {
    const byField = new Map(row.map((f) => [f.field, f.value]));
    return columns.map((c) => byField.get(c) ?? null);
  });
  return { columns, rows };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The lines around `ts` from the lines before it and those at or after it
 * (both oldest first): the anchor is the line logged at `ts` (lines carry
 * their own time, a little before CloudWatch's), else the first one after
 * it, else the last one before it.
 */
export function contextLines(
  before: ReadonlyArray<LogLine>,
  after: ReadonlyArray<LogLine>,
  ts: number,
  counts: { readonly before: number; readonly after: number },
): { readonly lines: LogLine[]; readonly anchor: number } | undefined {
  const all = [...before, ...after];
  if (all.length === 0) return undefined;
  const iso = new Date(ts).toISOString();
  const exact = after.findIndex((l) => l.ts === iso);
  const anchor = exact >= 0 ? before.length + exact : after.length ? before.length : before.length - 1;
  const start = Math.max(0, anchor - counts.before);
  return { lines: all.slice(start, anchor + counts.after + 1), anchor: anchor - start };
}
