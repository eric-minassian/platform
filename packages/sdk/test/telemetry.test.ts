import { SLOW_TRACE_MS, type TelemetryEvent, traceSampled } from '@ericminassian/platform-core';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newContext, runWithContext, setRoute } from '../src/runtime/context.ts';
import { emit, log, MAX_HELD_SPANS, setTraceSampler, span } from '../src/runtime/telemetry.ts';
import {
  captureTelemetry,
  createPlatformFetch,
  createWorkerHandler,
  resetPlatform,
  useTestBindings,
} from '../src/testing.ts';
import { traced } from '../src/traced.ts';

class Throttled extends Schema.TaggedError<Throttled, { readonly brand: unique symbol }>()('Throttled', {
  message: Schema.String,
}) {}

/** In the sampled share of traces, and not. */
const SAMPLED = '00000000000000000000000000000080';
const UNSAMPLED = '0123456789abcdef0123456789abcdef';

let tel: ReturnType<typeof captureTelemetry>;
beforeEach(() => {
  useTestBindings({
    app: 'todo',
    stage: 'prod',
    revision: 'd01m7gsrgesfbngnr0s9yseggvm',
    url: 'https://todo.ericminassian.com',
    host: 'todo.ericminassian.com',
  });
  tel = captureTelemetry();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.PLATFORM_LOG_PRETTY;
  tel.stop();
  resetPlatform();
});

function ofType<T extends TelemetryEvent['t']>(t: T) {
  return tel.events.filter((e): e is Extract<TelemetryEvent, { t: T }> => e.t === t);
}

/** A call that takes `ms` (real time, or fake time under fake timers). */
const call = (op: string, name: string, ms = 4) =>
  span(op, name, async () => {
    if (vi.isFakeTimers()) vi.advanceTimersByTime(ms);
    else await new Promise((r) => setTimeout(r, ms));
  });

/** One request to an app that makes three calls, runs `more`, then answers `status`. */
function request(trace: string, options: { status?: number; more?: () => unknown } = {}) {
  const f = createPlatformFetch(async () => {
    setRoute('/api/todos');
    await call('db.get', 'users');
    await call('db.query', 'todos');
    await call('db.put', 'todos');
    await options.more?.();
    const body = JSON.stringify({ items: [] });
    return new Response(body, {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    });
  });
  return f(
    new Request('https://todo.ericminassian.com/api/todos', {
      headers: { 'x-platform-trace': trace, 'cloudfront-viewer-country': 'US' },
    }),
  );
}

describe('spans of a request or job', () => {
  it('uses trace ids on both sides of the sample', () => {
    expect(traceSampled(SAMPLED)).toBe(true);
    expect(traceSampled(UNSAMPLED)).toBe(false);
  });

  it('are counted on the line of a request that passed', async () => {
    await request(UNSAMPLED);
    expect(ofType('span')).toEqual([]);
    const [req] = ofType('req');
    expect(req).toMatchObject({ status: 200, trace: UNSAMPLED, calls: 3 });
    expect(req!.callMs).toBeGreaterThan(0);
    // Nothing points to the request's own span id, so it isn't written.
    expect(req).not.toHaveProperty('span');
  });

  it('are written for a request that failed', async () => {
    await request(UNSAMPLED, { status: 503 });
    const [req] = ofType('req');
    expect(req).not.toHaveProperty('calls');
    expect(ofType('span').map((s) => s.op)).toEqual(['db.get', 'db.query', 'db.put']);
    for (const s of ofType('span')) expect(s).toMatchObject({ trace: UNSAMPLED, parent: req!.span });
    // Spans come before their request's line, and keep the time each ended.
    expect(tel.events.map((e) => e.t)).toEqual(['span', 'span', 'span', 'err', 'req']);
    expect(ofType('span')[0]!.ts).toBeLessThanOrEqual(ofType('span')[2]!.ts);
  });

  it('are written for a request that reported an error, even one it answered', async () => {
    await request(UNSAMPLED, { more: () => log.error('lookup failed', new Error('stale cache')) });
    expect(ofType('req')).toMatchObject([{ status: 200 }]);
    expect(ofType('span')).toHaveLength(3);
  });

  it(`are written for a request that took ${SLOW_TRACE_MS} ms or longer`, async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    // Three calls of 4 ms, then one that brings the request to 999 ms, then to 1,000 ms.
    for (const ms of [987, 988]) await request(UNSAMPLED, { more: () => call('fetch', 'GET x', ms) });
    expect(ofType('req').map((r) => [r.dur, r.calls])).toEqual([
      [999, 4],
      [SLOW_TRACE_MS, undefined],
    ]);
    expect(ofType('span')).toHaveLength(4);
  });

  it('are written on every hop of a sampled trace, and on none of another', async () => {
    const worker = createWorkerHandler({
      invoke: { refresh: () => call('db.query', 'feeds') },
    });
    for (const trace of [SAMPLED, UNSAMPLED]) {
      await request(trace);
      await worker({ __platform: 'invoke', name: 'refresh', payload: null, trace }, {});
    }
    const spansOf = (trace: string) => ofType('span').filter((s) => s.trace === trace);
    expect(spansOf(SAMPLED).map((s) => s.op)).toEqual(['db.get', 'db.query', 'db.put', 'db.query']);
    expect(spansOf(UNSAMPLED)).toEqual([]);
    const jobs = ofType('job');
    expect(jobs).toMatchObject([
      { trace: SAMPLED, kind: 'invoke' },
      { trace: UNSAMPLED, kind: 'invoke', calls: 1 },
    ]);
    expect(spansOf(SAMPLED).at(-1)!.parent).toBe(jobs[0]!.span);
  });

  it('are written for a job that failed', async () => {
    const worker = createWorkerHandler({
      invoke: {
        refresh: async () => {
          await call('db.query', 'feeds');
          throw new Error('feed down');
        },
      },
    });
    await expect(
      worker({ __platform: 'invoke', name: 'refresh', payload: null, trace: UNSAMPLED }, {}),
    ).rejects.toThrow('feed down');
    expect(ofType('span')).toMatchObject([{ op: 'db.query', parent: ofType('job')[0]!.span }]);
    expect(ofType('job')).toMatchObject([{ status: 'error' }]);
  });

  it(`are held up to ${MAX_HELD_SPANS}, and the rest counted`, async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance'] });
    await request(UNSAMPLED, {
      status: 500,
      more: async () => {
        for (let i = 0; i < MAX_HELD_SPANS; i++) await call('db.get', 'items');
      },
    });
    expect(ofType('span')).toHaveLength(MAX_HELD_SPANS);
    expect(ofType('req')).toMatchObject([{ calls: 3, callMs: 12 }]);
  });

  it('that end after their request follow the choice it made', async () => {
    const late: Array<Promise<void>> = [];
    for (const trace of [SAMPLED, UNSAMPLED])
      await request(trace, { more: () => void late.push(call('queue.send', 'emails', 5)) });
    await Promise.all(late);
    expect(ofType('span').filter((s) => s.op === 'queue.send')).toMatchObject([{ trace: SAMPLED }]);
  });

  it('of a unit of work follow the same rule', async () => {
    setTraceSampler(() => false);
    const flush = (fail: boolean) =>
      Effect.promise(() => call('db.putMany', 'positions')).pipe(
        Effect.andThen(fail ? Effect.fail(new Throttled({ message: 'slow down' })) : Effect.void),
        traced('flush'),
      );
    await Effect.runPromise(flush(false));
    await Effect.runPromiseExit(flush(true));
    const jobs = ofType('job');
    expect(jobs).toMatchObject([
      { name: 'flush', status: 'ok', calls: 1 },
      { name: 'flush', status: 'error' },
    ]);
    expect(jobs[0]).not.toHaveProperty('span');
    expect(jobs[1]!.span).toMatch(/^[0-9a-f]{16}$/);
    expect(ofType('span')).toMatchObject([
      { op: 'db.putMany', trace: jobs[1]!.trace, parent: jobs[1]!.span },
    ]);
  });

  it('are written as they end in a context no request or job ends', async () => {
    await runWithContext(newContext(UNSAMPLED), () => call('db.get', 'users'));
    expect(ofType('span')).toMatchObject([{ op: 'db.get', trace: UNSAMPLED }]);
  });

  it('are all written as they end under plat dev', async () => {
    process.env.PLATFORM_LOG_PRETTY = '1';
    await request(UNSAMPLED);
    expect(tel.events.map((e) => e.t)).toEqual(['span', 'span', 'span', 'req']);
    expect(ofType('req')[0]).not.toHaveProperty('calls');
  });
});

describe('lines', () => {
  it('leave out a path that is its route and a first attempt', () => {
    const req = { method: 'GET', status: 200, dur: 3 };
    emit('req', { ...req, route: '/api/todos', path: '/api/todos' });
    emit('req', { ...req, route: '/api/todos/:id', path: '/api/todos/42' });
    const job = { kind: 'queue', name: 'emails', status: 'ok', dur: 3 } as const;
    emit('job', { ...job, attempt: 1 });
    emit('job', { ...job, attempt: 3 });
    expect(ofType('req')[0]).not.toHaveProperty('path');
    expect(ofType('req')[1]).toMatchObject({ path: '/api/todos/42' });
    expect(ofType('job')[0]).not.toHaveProperty('attempt');
    expect(ofType('job')[1]).toMatchObject({ attempt: 3 });
  });

  it('pin the bytes a typical request writes', async () => {
    // The same request (three calls, a 200) wrote four lines, 1,060 bytes, before spans were held
    // and lines compacted. CloudWatch Logs bills each byte, plus 26 bytes per line.
    vi.useFakeTimers({ now: new Date('2026-11-16T12:00:00Z'), toFake: ['Date', 'performance'] });
    const written = () => tel.events.map((e) => `${JSON.stringify(e)}\n`);
    const bytes = (lines: string[]) => lines.reduce((n, l) => n + Buffer.byteLength(l), 0);

    await request(UNSAMPLED);
    await request(UNSAMPLED); // warm
    const warm = written().slice(1);
    expect(warm).toEqual([
      '{"_p":1,"t":"req","ts":1794830400024,"app":"todo","stage":"prod","rev":"d01m7gsrgesfbngnr0s9yseggvm","trace":"0123456789abcdef0123456789abcdef","method":"GET","route":"/api/todos","status":200,"dur":12,"bytes":12,"country":"US","calls":3,"callMs":12}\n',
    ]);
    expect(bytes(warm)).toBe(251);

    tel.events.length = 0;
    await request(SAMPLED);
    expect(written()).toHaveLength(4);
    expect(bytes(written())).toBe(1_040);
  });
});
