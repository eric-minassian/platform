/**
 * How a stage's server runs, and what each way costs. Shared by the manifest
 * schema, the engine, the router, the SDK and the control plane's daily
 * chooser.
 *
 * - `request`: a regular Lambda function (arm64) behind a function URL. Each
 *   request is an invocation, billed by the millisecond (a cold start's INIT
 *   too) and by the request, from the account's monthly free tier first.
 *   Nothing is billed while no request runs.
 * - `instance`: a Lambda Web Function. An environment serves many requests at
 *   once and is billed for the memory it uses for as long as it lives (until
 *   about five minutes after its last request), plus vCPU while it works.
 *
 * Request mode costs less until a stage is busy about a quarter of the time,
 * so quiet stages run it and the chooser moves a busy prod stage to instance
 * mode (and back) by `simulateWebCompute`.
 */
import { base64url, fromBase64url } from './base64url.ts';
import { HOURS_PER_MONTH } from './compute.ts';
import { PROD_STAGE } from './constants.ts';

export const WEB_COMPUTE = ['request', 'instance'] as const;
export type WebCompute = (typeof WEB_COMPUTE)[number];

/** `web.compute` in plat.config.ts. */
export const WEB_COMPUTE_SETTINGS = ['auto', ...WEB_COMPUTE] as const;
export type WebComputeSetting = (typeof WEB_COMPUTE_SETTINGS)[number];

/**
 * Memory of a request-mode server unless `web.memoryMb` says otherwise, from
 * the template app's server bundle (2.1 MB, measured 2026-11-16). INIT took
 * 460–650 ms at 512, 1024 and 1769 MB alike, but Lambda gives the handler CPU
 * in proportion to memory: the first request after INIT took ~115 ms at
 * 512 MB, ~60 ms at 1024 and ~40 ms at 1769, and warm requests 12–148 ms at
 * 512 against 5–11 ms at the other two. So 1024 MB answers faster than 512 and
 * costs less per warm request (the shorter time more than pays for the
 * doubled rate); 1769 MB only costs more. Each environment used ~140 MB.
 */
export const WEB_REQUEST_MEMORY_MB = 1024;

/**
 * Most environments a Web Function endpoint runs at once. Lambda keeps
 * spare, billed environments next to busy ones (CI bursts ran 9–25), so this
 * also caps that headroom. Prod takes `web.maxEnvironments`.
 */
export const WEB_MAX_ENVIRONMENTS = { preview: 2, prod: 10 } as const;

/** The first `@ericminassian/platform` whose server bundle also runs as a request-mode handler. */
export const REQUEST_MODE_MIN_SDK = '0.4.0';

/** Whether a bundle built with this SDK version can run in request mode. */
export function supportsRequestMode(sdk: string | undefined): boolean {
  const v = sdk ? /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(sdk.trim()) : null;
  if (!v) return false;
  const min = REQUEST_MODE_MIN_SDK.split('.').map(Number);
  const got = [Number(v[1]), Number(v[2]), Number(v[3])];
  for (let i = 0; i < 3; i++) if (got[i] !== min[i]) return got[i]! > min[i]!;
  // A prerelease of the minimum predates it.
  return v[4] === undefined;
}

/**
 * The account Lambda concurrency `auto` needs before it runs request mode.
 * Request-mode servers share the account's concurrency with every worker; a
 * new account's limit is 10, which one burst of browser tests on a preview
 * can exceed, and Lambda answers throttled requests with errors. Web
 * Functions scale on their own quota. AWS keeps 100 unreserved at the usual
 * 1,000.
 */
export const REQUEST_MODE_MIN_ACCOUNT_CONCURRENCY = 100;

/** Why `auto` keeps a server off request mode on this account, or undefined when it needn't. */
export function requestModeBlocked(accountConcurrency: number | undefined): string | undefined {
  if (accountConcurrency === undefined || accountConcurrency >= REQUEST_MODE_MIN_ACCOUNT_CONCURRENCY)
    return undefined;
  return (
    `the account's Lambda concurrency limit is ${accountConcurrency}, and request mode needs ` +
    `${REQUEST_MODE_MIN_ACCOUNT_CONCURRENCY} (raise "Concurrent executions" in Service Quotas)`
  );
}

/**
 * The mode a deploy runs the server in. `auto` runs request mode everywhere
 * but prod, where a stage keeps the mode it has (the chooser changes it) and
 * starts in request mode. A bundle built with an SDK older than
 * `REQUEST_MODE_MIN_SDK` only runs as a Web Function, and so does `auto` on an
 * account without the Lambda concurrency request mode needs
 * (`requestModeBlocked`); `note` then says why.
 */
export function webComputeFor(input: {
  setting: WebComputeSetting;
  stage: string;
  /** The mode the stage's server runs in now, if it has one. */
  current?: WebCompute | undefined;
  /** The deployment's `@ericminassian/platform` version. */
  sdk?: string | undefined;
  /** The account's Lambda concurrency limit, when known. */
  accountConcurrency?: number | undefined;
}): { compute: WebCompute; note?: string } | { error: string } {
  const capable = supportsRequestMode(input.sdk);
  if (input.setting === 'instance') return { compute: 'instance' };
  const blocked = requestModeBlocked(input.accountConcurrency);
  if (input.setting === 'request') {
    if (!capable)
      return {
        error: `web.compute is 'request', but this build's @ericminassian/platform is ${input.sdk ?? 'unknown'}: request mode needs ${REQUEST_MODE_MIN_SDK} or later`,
      };
    // Asked for by name: it runs, with the warning.
    return blocked
      ? { compute: 'request', note: `request mode can be throttled: ${blocked}` }
      : { compute: 'request' };
  }
  if (!capable) return { compute: 'instance' };
  const wanted = input.stage === PROD_STAGE ? (input.current ?? 'request') : 'request';
  if (wanted === 'request' && blocked) return { compute: 'instance', note: `instance mode: ${blocked}` };
  return { compute: wanted };
}

/** `maxEnvironments` of a stage's Web Function endpoints. */
export function webMaxEnvironments(web: { maxEnvironments?: number | undefined }, stage: string): number {
  return stage === PROD_STAGE
    ? (web.maxEnvironments ?? WEB_MAX_ENVIRONMENTS.prod)
    : WEB_MAX_ENVIRONMENTS.preview;
}

// ---------------------------------------------------------------------------
// The origin secret

const ORIGIN_SECRET_INFO = 'platform:origin:v1';

/**
 * What the router sends a stage's request-mode server in `ORIGIN_HEADER`:
 * HKDF of the stage key, so the engine (which writes it into the route) and
 * the SDK (which checks it) agree without storing another secret.
 */
export async function originSecret(stageKey: string): Promise<string> {
  const raw = await crypto.subtle.importKey('raw', fromBase64url(stageKey), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(ORIGIN_SECRET_INFO),
    },
    raw,
    256,
  );
  return base64url(new Uint8Array(bits));
}

// ---------------------------------------------------------------------------
// Cost

/**
 * Prices behind the estimates, us-east-1, checked 2026-11-16. Request mode is
 * Lambda on arm64; its INIT is billed like duration. Web Functions bill the
 * memory an environment uses (not what it may use) for its whole life, vCPU
 * per second it works, and requests. Neither estimate subtracts the free
 * tier: the account's workers draw on it too.
 */
export const WEB_COMPUTE_PRICES_USD = {
  request: { gbSecond: 0.0000133334, perMillionRequests: 0.2 },
  instance: { gbSecond: 0.000003667, vcpuSecond: 0.0000277, perMillionRequests: 0.3 },
} as const;

/** How long a Web Function environment lives after its last request (measured: ~290 s). */
export const INSTANCE_IDLE_SECONDS = 290;
/**
 * How long Lambda keeps an idle request-mode environment for the next
 * request. Undocumented; observed to be several minutes, so the simulation
 * assumes the short end.
 */
export const REQUEST_IDLE_MINUTES = 5;
/** A Web Function environment's memory when CloudWatch has none for the stage (measured: ~250 MB). */
export const INSTANCE_DEFAULT_MEMORY_MB = 256;
/**
 * A cold start's INIT when the stage reported none (`env` lines' `initMs`,
 * which came within ~30 ms of Lambda's own figure). Measured: 460–650 ms for
 * the template app's server.
 */
export const DEFAULT_INIT_MS = 550;

/** One minute of a stage's requests (the telemetry's whole-stage minute rollup). */
export interface MinuteTraffic {
  /** Start of the minute, epoch ms. */
  ts: number;
  req: number;
  /** Time spent handling them, summed (ms). */
  durMs: number;
}

export interface WebComputeSimulationInput {
  /** Minutes with requests in `from`..`to` (the others had none). */
  minutes: readonly MinuteTraffic[];
  from: number;
  to: number;
  /** `web.memoryMb`. */
  requestMemoryMb: number;
  /** What a Web Function environment uses. */
  instanceMemoryMb: number;
  /** `web.concurrency`: requests one Web Function environment serves at once. */
  maxConcurrencyPerEnvironment: number;
  /** A cold start's INIT, ms. */
  initMs: number;
}

export interface WebComputeEstimate {
  /** A month of this traffic in request mode. */
  request: { monthlyUsd: number; coldStartsPerMonth: number };
  /** A month of this traffic in instance mode. */
  instance: { monthlyUsd: number; environmentHoursPerMonth: number };
  requestsPerMonth: number;
  /** Days of traffic the month is extrapolated from. */
  days: number;
}

const MINUTE = 60_000;
/** Environment lifetimes are tracked in slots of this many seconds. */
const SLOT_SECONDS = 10;

/**
 * Both modes' monthly cost for the traffic in `minutes`, extrapolated from
 * `from`..`to`. Minute data only has averages, so a minute's concurrency is
 * its handling time over 60 s:
 *
 * - request: handling time × memory, cold starts × INIT × memory, requests.
 *   A minute needs as many environments as its concurrency (at least one);
 *   environments idle longer than `REQUEST_IDLE_MINUTES` are gone.
 * - instance: environments alive from each busy minute until
 *   `INSTANCE_IDLE_SECONDS` after it, as many as its concurrency over
 *   `maxConcurrencyPerEnvironment` (at least one), × memory; vCPU for the
 *   time an environment has a request in flight; requests.
 *
 * Overlapping requests are what instance mode bills once and request mode
 * bills each, so a stage busy enough to keep requests overlapping is the one
 * that moves to instance mode.
 */
export function simulateWebCompute(input: WebComputeSimulationInput): WebComputeEstimate {
  const span = Math.max(input.to - input.from, MINUTE);
  const perMonth = (HOURS_PER_MONTH * 3_600_000) / span;
  const minutes = input.minutes
    .filter((m) => m.req > 0 && m.ts >= input.from && m.ts < input.to)
    .toSorted((a, b) => a.ts - b.ts);
  const prices = WEB_COMPUTE_PRICES_USD;

  let requests = 0;
  let durationSeconds = 0;
  let coldStarts = 0;
  let warm = 0;
  let lastBusy = Number.NEGATIVE_INFINITY;
  let vcpuSeconds = 0;
  const alive = new Map<number, number>();
  const lifeSlots = Math.ceil((60 + INSTANCE_IDLE_SECONDS) / SLOT_SECONDS);
  for (const m of minutes) {
    requests += m.req;
    durationSeconds += m.durMs / 1000;
    const concurrency = m.durMs / MINUTE;

    if (m.ts - lastBusy > REQUEST_IDLE_MINUTES * MINUTE) warm = 0;
    const needed = Math.max(1, Math.ceil(concurrency));
    if (needed > warm) {
      coldStarts += needed - warm;
      warm = needed;
    }
    lastBusy = m.ts;

    const environments = Math.max(1, Math.ceil(concurrency / input.maxConcurrencyPerEnvironment));
    const first = Math.floor(m.ts / 1000 / SLOT_SECONDS);
    for (let s = first; s < first + lifeSlots; s++) alive.set(s, Math.max(alive.get(s) ?? 0, environments));
    // vCPU bills the seconds an environment has a request in flight, once however many overlap.
    // With requests arriving at random, that share of the minute is 1 - e^(-concurrency).
    vcpuSeconds += 60 * environments * (1 - Math.exp(-concurrency / environments));
  }

  const requestGb = input.requestMemoryMb / 1024;
  const requestUsd =
    (durationSeconds + (coldStarts * input.initMs) / 1000) * requestGb * prices.request.gbSecond +
    (requests * prices.request.perMillionRequests) / 1e6;

  let environmentSeconds = 0;
  for (const n of alive.values()) environmentSeconds += n * SLOT_SECONDS;
  const instanceUsd =
    environmentSeconds * (input.instanceMemoryMb / 1024) * prices.instance.gbSecond +
    vcpuSeconds * prices.instance.vcpuSecond +
    (requests * prices.instance.perMillionRequests) / 1e6;

  return {
    request: {
      monthlyUsd: round4(requestUsd * perMonth),
      coldStartsPerMonth: Math.round(coldStarts * perMonth),
    },
    instance: {
      monthlyUsd: round4(instanceUsd * perMonth),
      environmentHoursPerMonth: Math.round(((environmentSeconds * perMonth) / 3600) * 10) / 10,
    },
    requestsPerMonth: Math.round(requests * perMonth),
    days: Math.round((span / 86_400_000) * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Switching

/** The other mode must cost this much less (a share of the current one's cost), this many days running. */
export const COMPUTE_SWITCH_RULE = { cheaperBy: 0.25, days: 3 } as const;

/** Days in a row the other mode was cheaper enough, kept on the stage. */
export interface ComputeStreak {
  to: WebCompute;
  days: number;
  /** The last day it was (UTC, `YYYY-MM-DD`). */
  day: string;
}

/**
 * Today's step of the switching rule: the streak to keep, and the mode to
 * switch to once the other mode has been `COMPUTE_SWITCH_RULE.cheaperBy`
 * cheaper `COMPUTE_SWITCH_RULE.days` days running. A second run on the same
 * day changes nothing; a day the other mode wasn't cheaper enough, or a day
 * without a run, starts the count over.
 */
export function nextComputeStreak(input: {
  current: WebCompute;
  estimate: Pick<WebComputeEstimate, 'request' | 'instance'>;
  streak?: ComputeStreak | undefined;
  /** Today, UTC `YYYY-MM-DD`. */
  day: string;
}): { streak?: ComputeStreak; switchTo?: WebCompute } {
  const other: WebCompute = input.current === 'request' ? 'instance' : 'request';
  const current = input.estimate[input.current].monthlyUsd;
  const cheaper = input.estimate[other].monthlyUsd <= current * (1 - COMPUTE_SWITCH_RULE.cheaperBy);
  if (!cheaper || current <= 0) return {};
  const prev = input.streak?.to === other ? input.streak : undefined;
  const days = prev?.day === input.day ? prev.days : prev?.day === previousDay(input.day) ? prev.days + 1 : 1;
  if (days >= COMPUTE_SWITCH_RULE.days) return { switchTo: other };
  return { streak: { to: other, days, day: input.day } };
}

const previousDay = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
