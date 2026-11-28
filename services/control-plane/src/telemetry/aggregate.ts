/**
 * Telemetry processor core (pure). Turns a batch of platform telemetry lines
 * into DynamoDB `ADD` updates for the rollup series and error-group upserts.
 * Aggregating per batch first keeps writes proportional to series × buckets,
 * not to requests.
 */
import {
  bucketStart,
  EdgeLogRecord,
  HEALTH_PATH,
  isPageView,
  latencyBucket,
  parseStageHost,
  RESOLUTION_TTL_DAYS,
  type Resolution,
  TelemetryEvent,
  telemetryKeys,
} from '@ericminassian/platform-core';
import { Option, Predicate, Schema } from 'effect';

/**
 * Every series at every resolution: the explorer charts and alert rules watch
 * routes, jobs, custom metrics and rate limits by the minute too. A batch
 * writes one row per series and bucket, so writes follow traffic and an idle
 * stage writes nothing.
 */
const RESOLUTIONS: readonly Resolution[] = ['1m', '1h', '1d'];

export interface RollupUpdate {
  pk: string;
  sk: string;
  /** Numeric attributes to `ADD`. */
  add: Record<string, number>;
  /** Attributes to `SET` (labels, last-run times). */
  set: Record<string, string | number>;
  /** Attributes that keep the largest value written (custom metrics' `max`); see `rollupUpdateInput`. */
  max?: Record<string, number>;
  /** Epoch seconds (DynamoDB TTL attribute `ttl`). */
  ttl: number;
}

export interface ErrorGroupUpdate {
  pk: string;
  /** Fingerprint. */
  sk: string;
  app: string;
  stage: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  name: string;
  message: string;
  source: string;
  sample: { stack?: string; route?: string; job?: string; trace?: string; rev?: string };
}

export interface Aggregation {
  rollups: RollupUpdate[];
  errors: ErrorGroupUpdate[];
  /** Platform events seen in the batch. */
  events: number;
}

const decodeEvent = Schema.decodeUnknownOption(TelemetryEvent);

/**
 * Extracts a platform telemetry event from one CloudWatch Logs message. Handles
 * raw JSON lines, lines with a Lambda text-format prefix (`<ts>\t<reqid>\tINFO\t{...}`),
 * and Lambda JSON-format envelopes (`{"message": ...}`). A line that isn't a
 * valid event (an older or foreign shape) is not telemetry.
 */
export function parseLogMessage(message: string): TelemetryEvent | null {
  const start = message.indexOf('{');
  if (start === -1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.slice(start));
  } catch {
    return null;
  }
  const event = decodeEvent(parsed);
  if (Option.isSome(event)) return event.value;
  const inner = Predicate.hasProperty(parsed, 'message') ? parsed.message : undefined;
  if (typeof inner === 'string') return parseLogMessage(inner);
  return Option.getOrNull(decodeEvent(inner));
}

const ttlFor = (bucket: number, res: Resolution) =>
  Math.floor(bucket / 1000) + RESOLUTION_TTL_DAYS[res] * 86_400;

const statusClass = (status: number): string | null =>
  status >= 200 && status < 600 ? `s${Math.floor(status / 100)}xx` : null;

/** Rollup rows a batch adds to, keyed by row: `bump` adds counters, labels and maxima to one. */
function rollupBatch() {
  const rollups = new Map<string, RollupUpdate>();
  const bump = (
    pk: string,
    sk: string,
    res: Resolution,
    bucket: number,
    add: Record<string, number>,
    set: Record<string, string | number> = {},
    max: Record<string, number> = {},
  ) => {
    const key = `${pk}\u0000${sk}`;
    let u = rollups.get(key);
    if (!u) {
      u = { pk, sk, add: {}, set: {}, ttl: ttlFor(bucket, res) };
      rollups.set(key, u);
    }
    for (const [k, v] of Object.entries(add)) u.add[k] = (u.add[k] ?? 0) + v;
    for (const [k, v] of Object.entries(max)) {
      u.max ??= {};
      u.max[k] = Math.max(u.max[k] ?? v, v);
    }
    for (const [k, v] of Object.entries(set)) {
      // For timestamps keep the latest; for labels the value is constant anyway.
      const prev = u.set[k];
      if (typeof v === 'number' && typeof prev === 'number') u.set[k] = Math.max(prev, v);
      else u.set[k] = v;
    }
  };
  return { rollups, bump };
}

export function aggregate(events: readonly TelemetryEvent[]): Aggregation {
  const { rollups, bump } = rollupBatch();
  const errors = new Map<string, ErrorGroupUpdate>();

  for (const e of events) {
    const { app, stage, ts } = e;
    switch (e.t) {
      case 'req': {
        // The platform's own probes of the health path (the uptime pinger, deploys waiting for the
        // edge) aren't traffic. The pinger reads a stage's traffic as its uptime, so a probe it
        // counted would make a silent stage look served, or a failed probe look like a quiet minute.
        if (e.route === HEALTH_PATH) break;
        const cls = statusClass(e.status);
        // `dur` sums handling time: the compute chooser's concurrency and billed duration.
        const add: Record<string, number> = { req: 1, dur: e.dur, [`l${latencyBucket(e.dur)}`]: 1 };
        if (cls) add[cls] = 1;
        if (e.cold) add.cold = 1;
        for (const res of RESOLUTIONS) {
          const b = bucketStart(ts, res);
          bump(telemetryKeys.stage(app, stage, res), telemetryKeys.time(b), res, b, add);
        }
        const routeAdd: Record<string, number> = { req: 1, [`l${latencyBucket(e.dur)}`]: 1 };
        if (cls) routeAdd[cls] = 1;
        if (e.cold) routeAdd.cold = 1;
        for (const res of RESOLUTIONS) {
          const b = bucketStart(ts, res);
          bump(
            telemetryKeys.route(app, stage, res),
            `${telemetryKeys.time(b)}#${e.method} ${e.route}`,
            res,
            b,
            routeAdd,
            { method: e.method, route: e.route },
          );
        }
        break;
      }
      case 'job': {
        const add: Record<string, number> = {
          [e.status === 'ok' ? 'ok' : 'error']: 1,
          [`l${latencyBucket(e.dur)}`]: 1,
        };
        for (const res of RESOLUTIONS) {
          const b = bucketStart(ts, res);
          bump(
            telemetryKeys.job(app, stage, res),
            `${telemetryKeys.time(b)}#${e.kind}:${e.name}`,
            res,
            b,
            add,
            {
              kind: e.kind,
              name: e.name,
              lastRun: ts,
            },
          );
        }
        break;
      }
      case 'metric': {
        for (const res of RESOLUTIONS) {
          const b = bucketStart(ts, res);
          bump(
            telemetryKeys.metric(app, stage, res),
            `${telemetryKeys.time(b)}#${e.name}`,
            res,
            b,
            { count: 1, sum: e.value },
            { name: e.name, ...(e.unit ? { unit: e.unit } : {}) },
            { max: e.value },
          );
        }
        break;
      }
      case 'limit': {
        for (const res of RESOLUTIONS) {
          const b = bucketStart(ts, res);
          bump(
            telemetryKeys.limit(app, stage, res),
            `${telemetryKeys.time(b)}#${e.name}`,
            res,
            b,
            { [e.ok ? 'allowed' : 'denied']: 1 },
            { name: e.name },
          );
        }
        break;
      }
      case 'env': {
        if (e.event !== 'start') break;
        const field = { web: 'webStarts', worker: 'workerStarts' }[e.runtime];
        // A server's INIT, for the compute chooser's cold starts.
        const init: Record<string, number> =
          e.runtime === 'web' && e.initMs !== undefined ? { webInitMs: e.initMs, webInits: 1 } : {};
        for (const res of RESOLUTIONS) {
          const b = bucketStart(ts, res);
          bump(telemetryKeys.stage(app, stage, res), telemetryKeys.time(b), res, b, { [field]: 1, ...init });
        }
        break;
      }
      case 'err': {
        for (const res of RESOLUTIONS) {
          const b = bucketStart(ts, res);
          bump(telemetryKeys.stage(app, stage, res), telemetryKeys.time(b), res, b, { errors: 1 });
        }
        const pk = telemetryKeys.errors(app, stage);
        const key = `${pk}\u0000${e.fingerprint}`;
        const iso = new Date(ts).toISOString();
        const sample = {
          ...(e.stack ? { stack: e.stack } : {}),
          ...(e.route ? { route: e.route } : {}),
          ...(e.job ? { job: e.job } : {}),
          ...(e.trace ? { trace: e.trace } : {}),
          rev: e.rev,
        };
        const prev = errors.get(key);
        if (!prev) {
          errors.set(key, {
            pk,
            sk: e.fingerprint,
            app,
            stage,
            count: 1,
            firstSeen: iso,
            lastSeen: iso,
            name: e.name,
            message: e.message,
            source: e.source,
            sample,
          });
        } else {
          prev.count += 1;
          if (iso < prev.firstSeen) prev.firstSeen = iso;
          if (iso >= prev.lastSeen) {
            prev.lastSeen = iso;
            prev.message = e.message;
            prev.sample = sample;
          }
        }
        break;
      }
      // Logs and spans are read back from CloudWatch Logs (search, traces), not rolled up.
      case 'log':
      case 'span':
        break;
    }
  }
  return { rollups: [...rollups.values()], errors: [...errors.values()], events: events.length };
}

const decodeEdgeRecord = Schema.decodeUnknownOption(EdgeLogRecord);

/** One message of the router's access log as a record, or null when it isn't one. */
export function parseEdgeMessage(message: string): EdgeLogRecord | null {
  try {
    return Option.getOrNull(decodeEdgeRecord(JSON.parse(message)));
  } catch {
    return null;
  }
}

/**
 * The router's access log (`platformNames.edgeLogGroup`) as edge rollups
 * (`telemetryKeys.edge`) of the stages its hosts name: each request, by
 * status class, and whether it loaded a page. Health checks aren't traffic
 * (as in `aggregate`). Only stages the platform `serves` count: a host that
 * names none (a typo, a scan of made-up names, the edge host itself) gets a
 * 404 and no rows.
 */
export function aggregateEdge(
  messages: readonly string[],
  domain: string,
  serves: (app: string, stage: string) => boolean,
): Aggregation {
  const { rollups, bump } = rollupBatch();
  let events = 0;
  for (const message of messages) {
    const r = parseEdgeMessage(message);
    if (!r) continue;
    const ts = Number(r['timestamp(ms)']);
    const status = Number(r['sc-status']);
    if (!Number.isFinite(ts) || !Number.isFinite(status)) continue;
    const uri = r['cs-uri-stem'];
    if (uri === HEALTH_PATH) continue;
    const target = parseStageHost(r['x-host-header'], domain);
    if (!target || !serves(target.app, target.stage)) continue;
    events++;
    const add: Record<string, number> = { req: 1 };
    const cls = statusClass(status);
    if (cls) add[cls] = 1;
    if (isPageView(r['cs-method'], uri, status, r['sc-content-type'])) add.pages = 1;
    for (const res of RESOLUTIONS) {
      const b = bucketStart(ts, res);
      bump(telemetryKeys.edge(target.app, target.stage, res), telemetryKeys.time(b), res, b, add);
    }
  }
  return { rollups: [...rollups.values()], errors: [], events };
}

/**
 * DynamoDB UpdateItem input for one rollup: `SET ttl, labels ADD counters`.
 * An update can't keep a maximum, so `max` attributes are only set when the
 * row has none, and the update returns the row: `maxFollowUps` then raises
 * those the batch beat, which after a bucket's first few batches is rare.
 */
export function rollupUpdateInput(table: string, u: RollupUpdate) {
  const names: Record<string, string> = { '#ttl': 'ttl' };
  const values: Record<string, unknown> = { ':ttl': u.ttl };
  const adds: string[] = [];
  const sets: string[] = ['#ttl = :ttl'];
  Object.entries(u.add).forEach(([k, v], i) => {
    names[`#a${i}`] = k;
    values[`:a${i}`] = v;
    adds.push(`#a${i} :a${i}`);
  });
  Object.entries(u.set).forEach(([k, v], i) => {
    names[`#s${i}`] = k;
    values[`:s${i}`] = v;
    sets.push(`#s${i} = :s${i}`);
  });
  const max = Object.entries(u.max ?? {});
  max.forEach(([k, v], i) => {
    names[`#x${i}`] = k;
    values[`:x${i}`] = v;
    sets.push(`#x${i} = if_not_exists(#x${i}, :x${i})`);
  });
  return {
    TableName: table,
    Key: { pk: u.pk, sk: u.sk },
    UpdateExpression: `SET ${sets.join(', ')}${adds.length ? ` ADD ${adds.join(', ')}` : ''}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ...(max.length ? { ReturnValues: 'ALL_NEW' as const } : {}),
  };
}

/**
 * The updates that raise a rollup's `max` attributes to the batch's, given
 * the row `rollupUpdateInput` returned. Each applies only while the stored
 * value is still lower, so concurrent batches keep the largest.
 */
export function maxFollowUps(table: string, u: RollupUpdate, row: Record<string, unknown> | undefined) {
  return Object.entries(u.max ?? {})
    .filter(([k, v]) => {
      const stored = row?.[k];
      return typeof stored === 'number' && stored < v;
    })
    .map(([k, v]) => ({
      TableName: table,
      Key: { pk: u.pk, sk: u.sk },
      UpdateExpression: 'SET #m = :m',
      ConditionExpression: '#m < :m',
      ExpressionAttributeNames: { '#m': k },
      ExpressionAttributeValues: { ':m': v },
    }));
}
