import { RATE_LIMIT_PK_PREFIX } from '@ericminassian/platform-core';
import { Clock, Context, Duration, Effect, Layer } from 'effect';
import type { HttpServerRequest } from 'effect/http';
import type { HttpApiMiddleware } from 'effect/http-api';
import { RateLimited } from './api.ts';
import { clientInfo } from './client-info.ts';
import { addToCounter, type CounterWrite, readCounter } from './runtime/rate-limit.ts';
import { emit } from './runtime/telemetry.ts';

export interface RateLimitOptions {
  /** Uses allowed in any span of `per`: a positive integer. */
  readonly max: number;
  /** The span, from 1 second to 30 days: `'1 minute'`, `'1 hour'`, `Duration.days(1)`. */
  readonly per: Duration.Input;
  /** What this use counts as, such as a stroke's points: a positive integer up to `max`. Default 1. */
  readonly cost?: number | undefined;
  /**
   * Whom the limit counts, such as a user id. Default: the client's network
   * (`clientInfo`'s `network`), which needs the HTTP request.
   */
  readonly key?: string | undefined;
}

export interface RateLimitResult {
  /** Whether the use fit, and so was counted. A use that doesn't fit isn't counted. */
  readonly ok: boolean;
  /** Uses left right now (after this one, when it fit), rounded down. */
  readonly remaining: number;
  /** How long until a use of the same cost would fit, if no others come meanwhile. Zero when `ok`. */
  readonly retryAfter: Duration.Duration;
}

/** What `RateLimits.middleware` counts each request against, per client network. */
export interface RateLimitPolicy {
  readonly max: number;
  readonly per: Duration.Input;
  /** The limit's name in the console and `plat metrics`. Default: the middleware's id. */
  readonly name?: string | undefined;
}

/** An `HttpApiMiddleware` declared with `{ error: RateLimited }`, which `RateLimits.middleware` implements. */
export type RateLimitMiddleware = HttpApiMiddleware.HttpApiMiddleware<never, typeof RateLimited, never>;

/**
 * Refuses a middleware whose declaration doesn't list `RateLimited`: its 429
 * couldn't be encoded. (Without this, any middleware would do: one that fails
 * with nothing is assignable to one that may fail.)
 */
type DeclaresRateLimited<Self extends HttpApiMiddleware.AnyId> = [RateLimited] extends [
  HttpApiMiddleware.Error<Self>,
]
  ? unknown
  : { readonly 'declare the middleware with { error: RateLimited }': never };

/** One check, as `Platform.Memory` records it. */
export interface RateLimitCheck {
  readonly name: string;
  readonly key: string;
  readonly ok: boolean;
}

type Keyed = RateLimitOptions & { readonly key: string };
type Request = HttpServerRequest.HttpServerRequest;

/**
 * Rate limits for abuse control: signups per network, writes per client per
 * minute, sends per user per day. Each named limit allows `max` uses in any
 * span of `per`, per key (by default the client's network).
 *
 * The count is a sliding window: the uses in the current window of length
 * `per`, plus the previous window's weighted by how much of it is still
 * within the last `per` (as if its uses were spread evenly). Counts live in
 * the stage's table (`db: true`), one conditional write per check, so
 * concurrent checks never let more than `max` through. Each instance
 * remembers the counts it saw, and refuses a client it already knows is over
 * the limit without a database call, so a flood costs no more writes.
 */
export class RateLimits extends Context.Service<
  RateLimits,
  {
    /**
     * Counts a use of `name` for `key` (`cost` uses) if it fits under the
     * limit; one that doesn't fit isn't counted. Limits with the same name and
     * key share their count when `per` is the same too; keep one `max` per name.
     */
    check(name: string, options: Keyed): Effect.Effect<RateLimitResult>;
    check(name: string, options: RateLimitOptions): Effect.Effect<RateLimitResult, never, Request>;
    /** `check`, failing with `RateLimited` (429 with `Retry-After`) when the use doesn't fit. */
    enforce(name: string, options: Keyed): Effect.Effect<RateLimitResult, RateLimited>;
    enforce(name: string, options: RateLimitOptions): Effect.Effect<RateLimitResult, RateLimited, Request>;
  }
>()('@ericminassian/platform/RateLimits') {
  /** Counts in the stage's table, through its bindings; each check writes a `limit` telemetry line. */
  static readonly layer: Layer.Layer<RateLimits> = Layer.sync(RateLimits, () =>
    makeRateLimits(dynamoCounters, ({ name, ok }) => emit('limit', { name, ok })),
  );

  /** In memory, with the same windows, rounding and refusals. Each layer starts empty. */
  static readonly layerMemory = (): Layer.Layer<RateLimits> =>
    Layer.sync(RateLimits, () => makeRateLimits(memoryCounters(), () => {}));

  /**
   * Implements `middleware` (declared with `{ error: RateLimited }` in the
   * API definition): each request behind it counts once against `policy` for
   * its client's network, and one over the limit answers 429 with
   * `Retry-After` before the handler runs. Endpoints behind the same
   * middleware share one count.
   */
  static readonly middleware = <Self extends HttpApiMiddleware.AnyId>(
    middleware: Context.Key<Self, RateLimitMiddleware> & DeclaresRateLimited<Self>,
    policy: RateLimitPolicy,
  ): Layer.Layer<Self, never, RateLimits> =>
    Layer.effect(
      middleware,
      Effect.gen(function* () {
        const limits = yield* RateLimits;
        const name = policy.name ?? middleware.key;
        const options = { max: policy.max, per: policy.per };
        // Refuse a bad policy when the server starts, not on its first request.
        yield* Effect.sync(() => limitOf(name, options));
        return (httpEffect) => Effect.andThen(limits.enforce(name, options), httpEffect);
      }),
    );
}

// ---------------------------------------------------------------- validation

const LIMIT_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MIN_PER_MS = 1000;
const MAX_PER_MS = 30 * 86_400_000;
/** DynamoDB partition keys take 2048 bytes; this leaves room for the prefix and name. */
const MAX_KEY_BYTES = 1024;

interface Limit {
  readonly name: string;
  readonly length: number;
  readonly max: number;
  readonly cost: number;
}

/** The limit `options` describe; throws (a defect) naming what's wrong. */
function limitOf(name: string, options: RateLimitOptions): Limit {
  const what = `RateLimits "${name}"`;
  if (!LIMIT_NAME.test(name))
    throw new Error(
      `RateLimits: "${name}" is not a valid limit name: start with a letter, then up to 63 letters, digits, "_", "." or "-"`,
    );
  const { max, cost = 1 } = options;
  if (!Number.isSafeInteger(max) || max < 1)
    throw new Error(`${what}: max must be a positive integer, not ${max}`);
  if (!Number.isSafeInteger(cost) || cost < 1)
    throw new Error(`${what}: cost must be a positive integer, not ${cost}`);
  if (cost > max)
    throw new Error(
      `${what}: a use costing ${cost} can never fit under max ${max}. Bound what sets the cost (the payload's schema) so it stays within max.`,
    );
  const length = Duration.toMillis(Duration.fromInputUnsafe(options.per));
  if (!Number.isInteger(length) || length < MIN_PER_MS || length > MAX_PER_MS)
    throw new Error(`${what}: per must be whole milliseconds from 1 second to 30 days`);
  return { name, length, max, cost };
}

function checkKey(name: string, key: string): void {
  if (key === '') throw new Error(`RateLimits "${name}": key must not be empty`);
  if (new TextEncoder().encode(key).length > MAX_KEY_BYTES)
    throw new Error(`RateLimits "${name}": key must be at most ${MAX_KEY_BYTES} bytes; hash a longer one`);
}

// ---------------------------------------------------------------- windows

/** Where a moment falls in windows of `length` ms, numbered from the epoch. */
interface WindowAt {
  readonly index: number;
  readonly elapsed: number;
  readonly length: number;
}

const windowAt = (now: number, length: number): WindowAt => {
  const index = Math.floor(now / length);
  return { index, elapsed: now - index * length, length };
};

/**
 * What the previous window's `prev` uses count for now: the share of that
 * window still within the last `length` ms, 1 as a window starts and falling
 * to 0. Multiplied before dividing, so a count that lands on a whole number
 * is exact, and comparisons with whole-number limits stay exact.
 */
const weigh = (prev: number, w: WindowAt) => (prev * (w.length - w.elapsed)) / w.length;

/**
 * How long until `cost` more fits under `max`, if nothing else is used
 * meanwhile: as the previous window's share shrinks, or, when this window's
 * own count leaves no room, once it is the previous window and its share has
 * shrunk enough. `cost <= max`, so there always is such a moment.
 */
export function retryAfterMs(w: WindowAt, prev: number, cur: number, cost: number, max: number): number {
  const left = w.length - w.elapsed;
  if (cur + cost <= max) return prev > 0 ? Math.max(0, left - (w.length * (max - cost - cur)) / prev) : 0;
  return left + Math.max(0, w.length - (w.length * (max - cost)) / cur);
}

// ---------------------------------------------------------------- the checks

/** Where counts are kept: the stage's table, or memory. */
interface Counters {
  /** The uses counted in one window; 0 when it has none. */
  read(limit: string, pk: string, sk: string): Effect.Effect<number>;
  /** Adds `cost` while the count is at most `room`: the count after, or the one that refused it. */
  add(limit: string, write: CounterWrite): Effect.Effect<{ readonly added: boolean; readonly count: number }>;
}

/** What one instance last saw of a counter: the previous window's final count, and a floor on the current one's. */
interface Seen {
  readonly window: number;
  readonly prev: number;
  readonly cur: number;
}

/** Counters an instance remembers; past this, the least recently checked are forgotten. */
const SEEN_MAX = 10_000;

export function makeRateLimits(
  counters: Counters,
  report: (check: RateLimitCheck) => void,
): RateLimits['Service'] {
  const seen = new Map<string, Seen>();
  const remember = (id: string, s: Seen) => {
    seen.delete(id);
    seen.set(id, s);
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!);
  };

  const fits = (limit: Limit, w: WindowAt, prev: number, count: number): RateLimitResult => ({
    ok: true,
    remaining: Math.max(0, Math.floor(limit.max - weigh(prev, w) - count)),
    retryAfter: Duration.zero,
  });
  const over = (limit: Limit, w: WindowAt, prev: number, cur: number): RateLimitResult => ({
    ok: false,
    remaining: Math.max(0, Math.floor(limit.max - weigh(prev, w) - cur)),
    // At least a millisecond: a refused use is never told to retry at once.
    retryAfter: Duration.millis(Math.max(1, Math.ceil(retryAfterMs(w, prev, cur, limit.cost, limit.max)))),
  });

  const decide = (limit: Limit, key: string, now: number) =>
    Effect.gen(function* () {
      const w = windowAt(now, limit.length);
      const pk = `${RATE_LIMIT_PK_PREFIX}${limit.name}#${key}`;
      const sk = (index: number) => `${limit.length}#${index}`;
      const id = `${pk}\u0000${sk(0)}`;
      const last = seen.get(id);

      // Counts only grow within a window, so what this instance saw is a floor
      // on them: when the floor is already over the limit, so are the counts.
      const floor =
        last?.window === w.index
          ? last
          : last?.window === w.index - 1
            ? { prev: last.cur, cur: 0 }
            : undefined;
      if (floor && weigh(floor.prev, w) + floor.cur + limit.cost > limit.max)
        return over(limit, w, floor.prev, floor.cur);

      // The previous window is closed, so its count is read once per window.
      const prev =
        last?.window === w.index ? last.prev : yield* counters.read(limit.name, pk, sk(w.index - 1));
      const room = limit.max - limit.cost - weigh(prev, w);
      if (room < 0) {
        const cur = yield* counters.read(limit.name, pk, sk(w.index));
        remember(id, { window: w.index, prev, cur });
        return over(limit, w, prev, cur);
      }
      const { added, count } = yield* counters.add(limit.name, {
        pk,
        sk: sk(w.index),
        cost: limit.cost,
        room,
        // The item is the previous window until the next one ends.
        expiresAt: Math.ceil(((w.index + 2) * limit.length) / 1000),
      });
      remember(id, { window: w.index, prev, cur: count });
      return added ? fits(limit, w, prev, count) : over(limit, w, prev, count);
    });

  const check = (name: string, options: RateLimitOptions) =>
    Effect.gen(function* () {
      const limit = yield* Effect.sync(() => limitOf(name, options));
      const key = options.key ?? (yield* clientInfo).network;
      yield* Effect.sync(() => checkKey(name, key));
      const result = yield* decide(limit, key, yield* Clock.currentTimeMillis);
      report({ name, key, ok: result.ok });
      return result;
    });

  const enforce = (name: string, options: RateLimitOptions) =>
    check(name, options).pipe(
      Effect.filterOrFail(
        (result) => result.ok,
        (result) => RateLimited.after(result.retryAfter),
      ),
    );

  // With a key, nothing needs the request; the overloads say so.
  return RateLimits.of({
    check: check as RateLimits['Service']['check'],
    enforce: enforce as RateLimits['Service']['enforce'],
  });
}

const dynamoCounters: Counters = {
  read: (limit, pk, sk) => Effect.promise(() => readCounter(limit, pk, sk)),
  add: (limit, write) => Effect.promise(() => addToCounter(limit, write)),
};

/** Counters in a map, applying the same condition as the table's write. */
export function memoryCounters(): Counters {
  const counts = new Map<string, number>();
  return {
    read: (_limit, pk, sk) => Effect.sync(() => counts.get(`${pk}\u0000${sk}`) ?? 0),
    add: (_limit, { pk, sk, cost, room }) =>
      Effect.sync(() => {
        const id = `${pk}\u0000${sk}`;
        const now = counts.get(id);
        if (now !== undefined && now > room) return { added: false, count: now };
        const count = (now ?? 0) + cost;
        counts.set(id, count);
        return { added: true, count };
      }),
  };
}
