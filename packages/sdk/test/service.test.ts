import type { TelemetryEvent } from '@ericminassian/platform-core';
import { Cause, Effect, Exit, Fiber, Layer, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineService, defineWorker, Platform, Queues, traced } from '../src/index.ts';
import { type RunServiceOptions, runService, type ServiceHost } from '../src/runtime/service.ts';
import { pretty, span } from '../src/runtime/telemetry.ts';
import {
  captureTelemetry,
  createWorkerHandler,
  mockClient,
  resetPlatform,
  useTestBindings,
} from '../src/testing.ts';

class Boom extends Schema.TaggedError<Boom, { readonly brand: unique symbol }>()('Boom', {
  message: Schema.String,
}) {}

let telemetry: ReturnType<typeof captureTelemetry>;
beforeEach(() => {
  process.env.PLATFORM_SERVICE = 'ais';
  useTestBindings({ app: 'atlas' });
  telemetry = captureTelemetry();
});
afterEach(() => {
  delete process.env.PLATFORM_SERVICE;
  telemetry.stop();
  resetPlatform();
});

function ofType<T extends TelemetryEvent['t']>(t: T) {
  return telemetry.events.filter((e): e is Extract<TelemetryEvent, { t: T }> => e.t === t);
}

/** Process hooks a test drives: send a stop signal or a crash, see the exit codes. */
function fakeHost() {
  let stop: ((signal: string) => void) | undefined;
  let crash: ((error: unknown) => void) | undefined;
  const exits: number[] = [];
  const host: ServiceHost = {
    onStopSignal(fn) {
      stop = fn;
      return () => (stop = undefined);
    },
    onCrash(fn) {
      crash = fn;
      return () => (crash = undefined);
    },
    exit: (code) => void exits.push(code),
  };
  return {
    host,
    exits,
    signal: (signal = 'SIGTERM') => stop?.(signal),
    crash: (error: unknown) => crash?.(error),
    listening: () => stop !== undefined && crash !== undefined,
  };
}

/** Records the backoff waits without waiting, and stops the service after `stopAfter` of them. */
function recordedSleep(host: ReturnType<typeof fakeHost>, stopAfter: number) {
  const waits: number[] = [];
  const sleep: NonNullable<RunServiceOptions['sleep']> = async (ms) => {
    waits.push(ms);
    if (waits.length === stopAfter) host.signal('SIGTERM');
  };
  return { waits, sleep };
}

const noJitter = { jitter: 0 };

describe('runService', () => {
  it('reruns a run that fails, dies or returns, reporting each', async () => {
    const host = fakeHost();
    const { waits, sleep } = recordedSleep(host, 3);
    let runs = 0;
    const program = defineService({
      layer: Platform.layerMemory(),
      run: Effect.suspend(() => {
        runs++;
        if (runs === 1) return Effect.fail(new Boom({ message: 'socket closed' }));
        if (runs === 2) return Effect.die(new Error('parse bug'));
        return Effect.void;
      }),
    });

    await runService(program, { host: host.host, sleep, backoff: { initialMs: 10, ...noJitter } });

    expect(host.exits).toEqual([0]);
    expect(runs).toBe(3);
    expect(waits).toEqual([10, 20, 40]);
    expect(ofType('env')).toMatchObject([
      { event: 'start', runtime: 'service', name: 'ais' },
      { event: 'stop', runtime: 'service', name: 'ais', reason: 'SIGTERM' },
    ]);
    expect(ofType('env')[0]!.initMs).toBeTypeOf('number');
    expect(ofType('job').map((j) => [j.kind, j.name, j.status])).toEqual([
      ['service', 'ais', 'error'],
      ['service', 'ais', 'error'],
      ['service', 'ais', 'ok'],
    ]);
    expect(ofType('err')).toMatchObject([
      { source: 'service', job: 'service:ais', message: 'socket closed' },
      { source: 'service', job: 'service:ais', message: 'parse bug' },
    ]);
    const warnings = ofType('log').filter((l) => l.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toContain("service ais's run returned");
    expect(host.listening()).toBe(false);
  });

  it('doubles the backoff up to its maximum and starts over after a long run', async () => {
    const host = fakeHost();
    const doubling = recordedSleep(host, 5);
    await runService(defineService({ layer: Layer.empty, run: Effect.fail('nope') }), {
      host: host.host,
      sleep: doubling.sleep,
      backoff: { initialMs: 1, maxMs: 8, ...noJitter },
    });
    expect(doubling.waits).toEqual([1, 2, 4, 8, 8]);

    const again = fakeHost();
    const reset = recordedSleep(again, 4);
    let runs = 0;
    await runService(
      defineService({
        layer: Layer.empty,
        run: Effect.suspend(() => (++runs === 3 ? Effect.sleep('40 millis') : Effect.void)).pipe(
          Effect.andThen(Effect.fail('nope')),
        ),
      }),
      {
        host: again.host,
        sleep: reset.sleep,
        backoff: { initialMs: 10, maxMs: 80, resetAfterMs: 30, ...noJitter },
      },
    );
    expect(reset.waits).toEqual([10, 20, 10, 20]);
  });

  it('adds at most the jitter fraction to each wait', async () => {
    const host = fakeHost();
    const { waits, sleep } = recordedSleep(host, 20);
    await runService(defineService({ layer: Layer.empty, run: Effect.void }), {
      host: host.host,
      sleep,
      backoff: { initialMs: 1_000, maxMs: 1_000, jitter: 0.1 },
    });
    for (const w of waits) {
      expect(w).toBeGreaterThanOrEqual(1_000);
      expect(w).toBeLessThanOrEqual(1_100);
    }
  });

  it('on SIGTERM interrupts the run, runs its finalizers, then the layer’s, and exits 0', async () => {
    const host = fakeHost();
    const order: string[] = [];
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const program = defineService({
      layer: Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => void order.push('layer')))),
      run: Effect.sync(() => started()).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sleep('20 millis').pipe(Effect.andThen(Effect.sync(() => void order.push('flushed')))),
        ),
      ),
    });

    const done = runService(program, { host: host.host });
    await running;
    host.signal('SIGTERM');
    host.signal('SIGTERM');
    await done;

    expect(order).toEqual(['flushed', 'layer']);
    expect(host.exits).toEqual([0]);
    expect(ofType('job')).toEqual([]);
    expect(ofType('err')).toEqual([]);
    expect(ofType('env').at(-1)).toMatchObject({ event: 'stop', reason: 'SIGTERM' });
  });

  it('a stop signal during the backoff stops without another run', async () => {
    const host = fakeHost();
    let runs = 0;
    const done = runService(defineService({ layer: Layer.empty, run: Effect.sync(() => void runs++) }), {
      host: host.host,
      backoff: { initialMs: 60_000 },
    });
    await expect.poll(() => runs).toBe(1);
    host.signal('SIGINT');
    await done;
    expect(runs).toBe(1);
    expect(host.exits).toEqual([0]);
    expect(ofType('env').at(-1)).toMatchObject({ event: 'stop', reason: 'SIGINT' });
  });

  it('exits 1 when finalizers outlast the stop timeout', async () => {
    const host = fakeHost();
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const done = runService(
      defineService({
        layer: Layer.empty,
        run: Effect.sync(() => started()).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.never)),
      }),
      { host: host.host, stopTimeoutMs: 30 },
    );
    await running;
    host.signal('SIGTERM');
    await done;
    expect(host.exits).toEqual([1]);
    expect(ofType('log').at(-1)).toMatchObject({ level: 'warn' });
    expect(ofType('log').at(-1)!.msg).toContain('did not stop within 0.03s of SIGTERM');
    expect(ofType('env').at(-1)).toMatchObject({ event: 'stop', reason: 'SIGTERM' });
  });

  it('reports a layer that fails to build and exits 1 without running', async () => {
    const host = fakeHost();
    let ran = false;
    await runService(
      defineService({
        layer: Layer.effectDiscard(Effect.fail(new Boom({ message: 'no API key' }))),
        run: Effect.sync(() => void (ran = true)),
      }),
      { host: host.host },
    );
    expect(ran).toBe(false);
    expect(host.exits).toEqual([1]);
    expect(ofType('err')).toMatchObject([{ source: 'service', job: 'service:ais', message: 'no API key' }]);
    expect(ofType('env').at(-1)).toMatchObject({ event: 'stop', reason: 'start failed' });
  });

  it('a stop signal while the layer builds is a stop, not a failure', async () => {
    const host = fakeHost();
    let building!: () => void;
    const built = new Promise<void>((r) => (building = r));
    const interrupted: string[] = [];
    const done = runService(
      defineService({
        layer: Layer.effectDiscard(
          Effect.sync(() => building()).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => void interrupted.push('build'))),
          ),
        ),
        run: Effect.void,
      }),
      { host: host.host },
    );
    await built;
    host.signal('SIGTERM');
    await done;
    expect(interrupted).toEqual(['build']);
    expect(host.exits).toEqual([0]);
    expect(ofType('err')).toEqual([]);
  });

  it('reports an uncaught exception and exits 1', async () => {
    const host = fakeHost();
    const done = runService(defineService({ layer: Layer.empty, run: Effect.never }), { host: host.host });
    host.crash(new Error('stray callback threw'));
    await done;
    expect(host.exits).toEqual([1]);
    expect(ofType('err')).toMatchObject([{ source: 'unhandled', message: 'stray callback threw' }]);
    expect(ofType('env').at(-1)).toMatchObject({ event: 'stop', reason: 'crash' });
  });
});

describe('traced', () => {
  const sent: Array<{ trace?: string }> = [];
  beforeEach(() => {
    // These are about which trace a span joins; whether it's written has tests of its own.
    telemetry.stop();
    telemetry = captureTelemetry({ spans: 'all' });
    sent.length = 0;
    useTestBindings({
      app: 'atlas',
      worker: 'atlas--test--worker',
      jobs: {
        queues: ['positions'],
        fns: {},
        attempts: {},
        dead: 'https://sqs/atlas--test--jobs--dead',
        group: 'atlas--test',
        role: 'arn:role',
      },
    });
    mockClient('lambda', (cmd) => {
      const job = JSON.parse(new TextDecoder().decode(cmd.input.Payload as Uint8Array)) as { trace?: string };
      sent.push({ trace: job.trace });
      return { StatusCode: 202 };
    });
  });

  const send = (n: number) =>
    Effect.gen(function* () {
      const queues = yield* Queues;
      yield* queues.send('positions', { n });
    });

  it('outside a request or job starts a trace that SDK calls inside it join', async () => {
    const unit: Effect.Effect<number, never, Queues> = send(1).pipe(Effect.as(7), traced('batch'));
    expect(await Effect.runPromise(unit.pipe(Effect.provide(Queues.layer)))).toBe(7);

    const [job] = ofType('job');
    expect(job).toMatchObject({ kind: 'service', name: 'ais/batch', status: 'ok' });
    expect(job!.trace).toMatch(/^[0-9a-f]{32}$/);
    expect(ofType('span')).toMatchObject([{ op: 'queue.send', trace: job!.trace, parent: job!.span }]);
    expect(sent).toEqual([{ trace: job!.trace }]);
  });

  it('names the job after the unit alone outside a service', async () => {
    delete process.env.PLATFORM_SERVICE;
    await Effect.runPromise(Effect.void.pipe(traced('import')));
    expect(ofType('job')).toMatchObject([{ kind: 'service', name: 'import', status: 'ok' }]);
  });

  it('passes a failure through unchanged and reports it', async () => {
    const error = new Boom({ message: 'bad frame' });
    const unit: Effect.Effect<never, Boom> = Effect.fail(error).pipe(traced('decode'));
    const exit = await Effect.runPromiseExit(unit);
    expect(exit).toEqual(Exit.fail(error));
    expect(ofType('job')).toMatchObject([{ kind: 'service', name: 'ais/decode', status: 'error' }]);
    expect(ofType('err')).toMatchObject([
      { source: 'service', job: 'service:ais/decode', message: 'bad frame', trace: ofType('job')[0]!.trace },
    ]);
  });

  it('passes interruption through, waits for finalizers and reports nothing', async () => {
    const order: string[] = [];
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.never.pipe(
          Effect.ensuring(
            Effect.sleep('10 millis').pipe(Effect.andThen(Effect.sync(() => void order.push('released')))),
          ),
          traced('hold'),
          Effect.forkChild,
        );
        yield* Effect.sleep('5 millis');
        yield* Fiber.interrupt(fiber);
        order.push('interrupted');
        return yield* Fiber.await(fiber);
      }),
    );
    expect(order).toEqual(['released', 'interrupted']);
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(ofType('job')).toEqual([]);
    expect(ofType('err')).toEqual([]);
  });

  it('keeps concurrent units on their own traces', async () => {
    const unit = (name: string) =>
      Effect.gen(function* () {
        for (let i = 0; i < 3; i++) {
          yield* Effect.promise(() => span('step', name, () => new Promise((r) => setTimeout(r, 2))));
          yield* Effect.sleep('1 millis');
          yield* send(i);
        }
      }).pipe(traced(name));
    await Effect.runPromise(
      Effect.all([unit('a'), unit('b'), unit('c')], { concurrency: 'unbounded' }).pipe(
        Effect.provide(Queues.layer),
      ),
    );
    const jobs = ofType('job');
    expect(jobs.map((j) => j.name).toSorted()).toEqual(['ais/a', 'ais/b', 'ais/c']);
    const traces = new Set(jobs.map((j) => j.trace));
    expect(traces.size).toBe(3);
    for (const job of jobs) {
      const steps = ofType('span').filter((s) => s.op === 'step' && `ais/${s.name}` === job.name);
      expect(steps).toHaveLength(3);
      for (const s of steps) expect(s).toMatchObject({ trace: job.trace, parent: job.span });
    }
    expect(ofType('span').filter((s) => s.op === 'queue.send')).toHaveLength(9);
    expect(new Set(sent.map((s) => s.trace))).toEqual(traces);
  });

  it('inside a job is a span of the job’s trace', async () => {
    const handler = createWorkerHandler(
      defineWorker({
        layer: Platform.layerMemory(),
        invoke: {
          refresh: () =>
            Effect.promise(() => span('db.query', 'feeds', async () => {})).pipe(
              traced('load'),
              Effect.andThen(Effect.void.pipe(traced('store'))),
            ),
        },
      }),
    );
    await handler({ __platform: 'invoke', name: 'refresh', payload: null }, {});
    const jobs = ofType('job');
    expect(jobs).toMatchObject([{ kind: 'invoke', name: 'refresh', status: 'ok' }]);
    const spans = ofType('span');
    expect(spans.map((s) => [s.op, s.name])).toEqual([
      ['db.query', 'feeds'],
      ['traced', 'load'],
      ['traced', 'store'],
    ]);
    for (const s of spans) expect(s).toMatchObject({ trace: jobs[0]!.trace, parent: jobs[0]!.span });
  });

  it('nested in a unit of its own is a span of that unit', async () => {
    await Effect.runPromise(Effect.void.pipe(traced('inner'), traced('outer')));
    const [job] = ofType('job');
    expect(job).toMatchObject({ name: 'ais/outer' });
    expect(ofType('span')).toMatchObject([{ op: 'traced', name: 'inner', trace: job!.trace }]);
  });

  it('in a service run gives each unit its own trace while the run has none', async () => {
    const host = fakeHost();
    let units = 0;
    const done = runService(
      defineService({
        layer: Queues.layer,
        run: Effect.gen(function* () {
          yield* send(0);
          for (;;) {
            yield* send(1).pipe(traced('tick'));
            if (++units === 2) host.signal('SIGTERM');
            yield* Effect.sleep('1 millis');
          }
        }),
      }),
      { host: host.host },
    );
    await done;
    const jobs = ofType('job');
    expect(jobs.map((j) => j.name)).toEqual(['ais/tick', 'ais/tick']);
    expect(jobs[0]!.trace).not.toBe(jobs[1]!.trace);
    // The send outside a unit has no trace to be part of.
    expect(ofType('span').map((s) => s.trace)).toEqual(jobs.map((j) => j.trace));
  });
});

describe('pretty', () => {
  // oxlint-disable-next-line eslint/no-control-regex -- stripping ANSI colors
  const plain = (e: TelemetryEvent) => pretty(e).replace(/\x1b\[[0-9;]*m/g, '');
  const base = { _p: 1 as const, ts: Date.UTC(2026, 10, 16, 9, 30), app: 'atlas', stage: 'local', rev: 'd1' };

  it('prints service starts, stops, runs and units', () => {
    expect(plain({ ...base, t: 'env', event: 'start', runtime: 'service', name: 'ais', initMs: 85 })).toBe(
      '09:30:00.000 service ais start (85ms)',
    );
    expect(
      plain({ ...base, t: 'env', event: 'stop', runtime: 'service', name: 'ais', reason: 'SIGTERM' }),
    ).toBe('09:30:00.000 service ais stop (SIGTERM)');
    expect(plain({ ...base, t: 'env', event: 'start', runtime: 'worker', initMs: 40 })).toBe(
      '09:30:00.000 worker start (40ms)',
    );
    expect(plain({ ...base, t: 'job', kind: 'service', name: 'ais', status: 'error', dur: 185_000 })).toBe(
      '09:30:00.000 service ais run failed after 3m 05s',
    );
    expect(plain({ ...base, t: 'job', kind: 'service', name: 'ais/batch', status: 'ok', dur: 12.5 })).toBe(
      '09:30:00.000 service:ais/batch ok 12.5ms',
    );
  });
});
