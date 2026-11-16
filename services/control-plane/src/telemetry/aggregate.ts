/**
 * Telemetry processor core (pure). Turns a batch of platform telemetry lines
 * into DynamoDB `ADD` updates for the rollup series and error-group upserts.
 * Aggregating per batch first keeps writes proportional to series × buckets,
 * not to requests.
 */
import {
  bucketStart,
  HEALTH_PATH,
  latencyBucket,
  RESOLUTION_TTL_DAYS,
  type Resolution,
  TelemetryEvent,
  telemetryKeys,
} from '@ericminassian/platform-core';
import { Option, Predicate, Schema } from 'effect';

/** Whole-stage HTTP series get minute resolution; per-route/job/metric series start at hourly. */
const STAGE_RES: readonly Resolution[] = ['1m', '1h', '1d'];
const SERIES_RES: readonly Resolution[] = ['1h', '1d'];

export interface RollupUpdate {
  pk: string;
  sk: string;
  /** Numeric attributes to `ADD`. */
  add: Record<string, number>;
  /** Attributes to `SET` (labels, last-run times). */
  set: Record<string, string | number>;
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

export function aggregate(events: readonly TelemetryEvent[]): Aggregation {
  const rollups = new Map<string, RollupUpdate>();
  const errors = new Map<string, ErrorGroupUpdate>();

  const bump = (
    pk: string,
    sk: string,
    res: Resolution,
    bucket: number,
    add: Record<string, number>,
    set: Record<string, string | number> = {},
  ) => {
    const key = `${pk}\u0000${sk}`;
    let u = rollups.get(key);
    if (!u) {
      u = { pk, sk, add: {}, set: {}, ttl: ttlFor(bucket, res) };
      rollups.set(key, u);
    }
    for (const [k, v] of Object.entries(add)) u.add[k] = (u.add[k] ?? 0) + v;
    for (const [k, v] of Object.entries(set)) {
      // For timestamps keep the latest; for labels the value is constant anyway.
      const prev = u.set[k];
      if (typeof v === 'number' && typeof prev === 'number') u.set[k] = Math.max(prev, v);
      else u.set[k] = v;
    }
  };

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
        for (const res of STAGE_RES) {
          const b = bucketStart(ts, res);
          bump(telemetryKeys.stage(app, stage, res), telemetryKeys.time(b), res, b, add);
        }
        const routeAdd: Record<string, number> = { req: 1, [`l${latencyBucket(e.dur)}`]: 1 };
        if (e.status >= 500) routeAdd.s5xx = 1;
        else if (e.status >= 400) routeAdd.s4xx = 1;
        for (const res of SERIES_RES) {
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
        for (const res of SERIES_RES) {
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
        for (const res of SERIES_RES) {
          const b = bucketStart(ts, res);
          bump(
            telemetryKeys.metric(app, stage, res),
            `${telemetryKeys.time(b)}#${e.name}`,
            res,
            b,
            { count: 1, sum: e.value },
            { name: e.name, ...(e.unit ? { unit: e.unit } : {}) },
          );
        }
        break;
      }
      case 'limit': {
        for (const res of SERIES_RES) {
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
        const field = { web: 'webStarts', worker: 'workerStarts', service: 'serviceStarts' }[e.runtime];
        // A server's INIT, for the compute chooser's cold starts.
        const init: Record<string, number> =
          e.runtime === 'web' && e.initMs !== undefined ? { webInitMs: e.initMs, webInits: 1 } : {};
        for (const res of STAGE_RES) {
          const b = bucketStart(ts, res);
          bump(telemetryKeys.stage(app, stage, res), telemetryKeys.time(b), res, b, { [field]: 1, ...init });
        }
        // A service's container starts sit next to its runs, on its job series.
        if (e.runtime === 'service' && e.name) {
          for (const res of SERIES_RES) {
            const b = bucketStart(ts, res);
            bump(
              telemetryKeys.job(app, stage, res),
              `${telemetryKeys.time(b)}#service:${e.name}`,
              res,
              b,
              { starts: 1 },
              { kind: 'service', name: e.name },
            );
          }
        }
        break;
      }
      case 'err': {
        for (const res of STAGE_RES) {
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

/** DynamoDB UpdateItem input for one rollup: `SET ttl, labels ADD counters`. */
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
  return {
    TableName: table,
    Key: { pk: u.pk, sk: u.sk },
    UpdateExpression: `SET ${sets.join(', ')}${adds.length ? ` ADD ${adds.join(', ')}` : ''}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}
