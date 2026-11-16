import { describe, expect, it } from 'vitest';
import {
  type MinuteTraffic,
  nextComputeStreak,
  originSecret,
  simulateWebCompute,
  supportsRequestMode,
  webComputeFor,
  webMaxEnvironments,
} from '../src/index.ts';

const MINUTE = 60_000;
const DAY = 86_400_000;

/** `count` busy minutes, `every` minutes apart from the start of the window. */
const minutes = (count: number, every: number, traffic: Omit<MinuteTraffic, 'ts'>): MinuteTraffic[] =>
  Array.from({ length: count }, (_, i) => ({ ts: i * every * MINUTE, ...traffic }));

const simulate = (traffic: MinuteTraffic[], days = 3) =>
  simulateWebCompute({
    minutes: traffic,
    from: 0,
    to: days * DAY,
    requestMemoryMb: 1024,
    instanceMemoryMb: 256,
    maxConcurrencyPerEnvironment: 64,
    initMs: 600,
  });

describe('web compute simulation', () => {
  it('prices a quiet stage far below a Web Function', () => {
    // Ten requests a day, each alone: every one starts an environment in request mode, and keeps a
    // Web Function environment alive for its minute plus ~290 s.
    const quiet = simulate(minutes(30, 144, { req: 1, durMs: 50 }));
    expect(quiet.days).toBe(3);
    expect(quiet.requestsPerMonth).toBe(304);
    expect(quiet.request.coldStartsPerMonth).toBe(304);
    // (30 × 0.05 s + 30 × 0.6 s INIT) × 1 GB × $0.0000133334 + 30 × $0.20/M, × 730 h / 72 h.
    expect(quiet.request.monthlyUsd).toBeCloseTo(0.0027, 4);
    // 30 × 350 s × 0.25 GB × $0.000003667, plus vCPU and requests.
    expect(quiet.instance.environmentHoursPerMonth).toBeCloseTo(29.6, 1);
    expect(quiet.instance.monthlyUsd).toBeCloseTo(0.098, 3);
  });

  it('prices a stage with overlapping requests below request mode', () => {
    // Every minute for three days, 600 requests of 500 ms: five in flight on average, which one Web
    // Function environment serves for one vCPU-second each second.
    const busy = simulate(minutes(3 * 1440, 1, { req: 600, durMs: 300_000 }));
    expect(busy.request.coldStartsPerMonth).toBe(51);
    // Alive all month, plus the last minute's tail.
    expect(busy.instance.environmentHoursPerMonth).toBeCloseTo(731, 0);
    expect(busy.instance.monthlyUsd).toBeLessThan(busy.request.monthlyUsd * 0.75);
  });

  it('keeps environments warm between close requests', () => {
    // A request every 3 minutes: request mode starts once; a Web Function environment never dies.
    const steady = simulate(minutes(480, 3, { req: 1, durMs: 40 }), 1);
    expect(steady.request.coldStartsPerMonth).toBe(Math.round(730 / 24));
    expect(steady.instance.environmentHoursPerMonth).toBeCloseTo(730, -1);
  });

  it('scales instance environments with concurrency over what one serves', () => {
    const one = simulate(minutes(10, 1, { req: 600, durMs: 60_000 * 32 }), 1);
    const three = simulate(minutes(10, 1, { req: 1800, durMs: 60_000 * 160 }), 1);
    expect(three.instance.environmentHoursPerMonth / one.instance.environmentHoursPerMonth).toBeCloseTo(3, 1);
  });

  it('costs nothing without traffic, and ignores minutes outside the window', () => {
    const none = simulate([{ ts: 5 * DAY, req: 10, durMs: 100 }]);
    expect(none.request.monthlyUsd).toBe(0);
    expect(none.instance.monthlyUsd).toBe(0);
    expect(none.requestsPerMonth).toBe(0);
  });
});

describe('switching modes', () => {
  const estimate = (request: number, instance: number) => ({
    request: { monthlyUsd: request, coldStartsPerMonth: 0 },
    instance: { monthlyUsd: instance, environmentHoursPerMonth: 0 },
  });

  it('switches once the other mode is 25% cheaper three days running', () => {
    const cheaper = estimate(4, 3);
    const day1 = nextComputeStreak({ current: 'request', estimate: cheaper, day: '2026-11-14' });
    expect(day1).toEqual({ streak: { to: 'instance', days: 1, day: '2026-11-14' } });
    const day2 = nextComputeStreak({
      current: 'request',
      estimate: cheaper,
      streak: day1.streak,
      day: '2026-11-15',
    });
    expect(day2.streak?.days).toBe(2);
    // A second run the same day doesn't count twice.
    expect(
      nextComputeStreak({ current: 'request', estimate: cheaper, streak: day2.streak, day: '2026-11-15' }),
    ).toEqual(day2);
    expect(
      nextComputeStreak({ current: 'request', estimate: cheaper, streak: day2.streak, day: '2026-11-16' }),
    ).toEqual({ switchTo: 'instance' });
  });

  it('starts over after a day that wasn’t cheaper enough, or a missed day', () => {
    const streak = { to: 'request' as const, days: 2, day: '2026-11-15' };
    // 3.10 is not 25% below 4.
    expect(
      nextComputeStreak({ current: 'instance', estimate: estimate(3.1, 4), streak, day: '2026-11-16' }),
    ).toEqual({});
    expect(
      nextComputeStreak({ current: 'instance', estimate: estimate(1, 4), streak, day: '2026-11-17' }),
    ).toEqual({ streak: { to: 'request', days: 1, day: '2026-11-17' } });
  });

  it('never switches a stage that costs nothing either way', () => {
    expect(nextComputeStreak({ current: 'request', estimate: estimate(0, 0), day: '2026-11-16' })).toEqual(
      {},
    );
  });
});

describe('which mode a deploy runs', () => {
  it('needs an SDK that builds the request-mode handler', () => {
    expect(supportsRequestMode('0.4.0')).toBe(true);
    expect(supportsRequestMode('0.10.2')).toBe(true);
    expect(supportsRequestMode('1.0.0-beta.1')).toBe(true);
    expect(supportsRequestMode('0.4.0-rc.1')).toBe(false);
    expect(supportsRequestMode('0.3.9')).toBe(false);
    expect(supportsRequestMode(undefined)).toBe(false);
    expect(supportsRequestMode('workspace:*')).toBe(false);
  });

  it('runs previews on requests and keeps prod where the chooser put it', () => {
    const sdk = '0.4.0';
    expect(webComputeFor({ setting: 'auto', stage: 'pr-3', current: 'instance', sdk })).toEqual({
      compute: 'request',
    });
    expect(webComputeFor({ setting: 'auto', stage: 'prod', sdk })).toEqual({ compute: 'request' });
    expect(webComputeFor({ setting: 'auto', stage: 'prod', current: 'instance', sdk })).toEqual({
      compute: 'instance',
    });
    expect(webComputeFor({ setting: 'instance', stage: 'pr-3', sdk })).toEqual({ compute: 'instance' });
    expect(webComputeFor({ setting: 'request', stage: 'prod', current: 'instance', sdk })).toEqual({
      compute: 'request',
    });
  });

  it('runs an older build as a Web Function, and refuses to run it per request', () => {
    expect(webComputeFor({ setting: 'auto', stage: 'pr-3', sdk: '0.3.0' })).toEqual({ compute: 'instance' });
    expect(webComputeFor({ setting: 'request', stage: 'prod', sdk: '0.3.0' })).toEqual({
      error:
        "web.compute is 'request', but this build's @ericminassian/platform is 0.3.0: request mode needs 0.4.0 or later",
    });
  });

  it('caps Web Function environments, previews at 2', () => {
    expect(webMaxEnvironments({}, 'prod')).toBe(10);
    expect(webMaxEnvironments({ maxEnvironments: 50 }, 'prod')).toBe(50);
    expect(webMaxEnvironments({ maxEnvironments: 50 }, 'pr-3')).toBe(2);
  });
});

describe('origin secret', () => {
  it('is derived from the stage key, differently from its other keys', async () => {
    const key = 'dGVzdC1vbmx5LXN0YWdlLWtleS1ub3QtYS1zZWNyZXQ';
    const secret = await originSecret(key);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await originSecret(key)).toBe(secret);
    expect(await originSecret('b3RoZXIta2V5LW9mLXRoZS1zYW1lLWxlbmd0aC4uLg')).not.toBe(secret);
  });
});
