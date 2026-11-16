/**
 * Long-running service runtime. An app's service module exports
 * `defineService({ layer, run })` (`../service.ts`), which compiles to a
 * `ServiceProgram`; `plat build` generates
 *
 *   import def from '<app>/src/ais.ts';
 *   import { runService } from '@ericminassian/platform/service';
 *   await runService(def);
 *
 * and the container runs that bundle (`PLATFORM_SERVICE` names the service).
 * runService builds the program, runs it until the process is told to stop,
 * reruns it with a backoff whenever it ends on its own, and reports all of it
 * as telemetry (`env`, `job` kind `service`, `err` source `service`).
 *
 * CONTRACT: used by the CLI build. Keep stable.
 */
import { SERVICE_ENV } from '@ericminassian/platform-core';
import { emit, emitError, installConsoleCapture, installFetchInstrumentation, log } from './telemetry.ts';

/** A service as the runtime runs it: what `defineService` compiles to. */
export interface ServiceProgram {
  /** Builds what `run` needs (the layer). Rejects when it can't; aborting `signal` gives up. */
  start(signal: AbortSignal): Promise<void>;
  /**
   * One run. Resolves if it returns, rejects if it fails. Aborting `signal`
   * interrupts it, and the promise settles once its finalizers have run.
   */
  run(signal: AbortSignal): Promise<unknown>;
  /** Releases what `start` built (the layer's finalizers). */
  dispose(): Promise<void>;
}

/** The process hooks runService installs. Tests pass their own. */
export interface ServiceHost {
  /** Call `stop` on SIGTERM or SIGINT; returns a function that removes the listeners. */
  onStopSignal(stop: (signal: string) => void): () => void;
  /** Call `crash` on an uncaught exception or unhandled rejection; returns a function that removes the listeners. */
  onCrash(crash: (error: unknown) => void): () => void;
  exit(code: number): void;
}

export interface RunServiceOptions {
  host?: ServiceHost;
  /** Rerun backoff, in ms. */
  backoff?: Partial<ServiceBackoff>;
  /** How long finalizers get after a stop signal before the process exits anyway. */
  stopTimeoutMs?: number;
  /** Waits between runs; resolves early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface ServiceBackoff {
  initialMs: number;
  maxMs: number;
  /** A run that lasted this long starts the backoff over. */
  resetAfterMs: number;
  /** Up to this fraction is added to each delay at random, so restarts don't move in lockstep. */
  jitter: number;
}

const BACKOFF: ServiceBackoff = { initialMs: 1_000, maxMs: 60_000, resetAfterMs: 5 * 60_000, jitter: 0.1 };

/** ECS sends SIGKILL 30 s after SIGTERM; exit on our own terms before that. */
const STOP_TIMEOUT_MS = 25_000;

const processHost: ServiceHost = {
  onStopSignal(stop) {
    const onTerm = () => stop('SIGTERM');
    const onInt = () => stop('SIGINT');
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    return () => {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
    };
  },
  onCrash(crash) {
    process.on('uncaughtException', crash);
    process.on('unhandledRejection', crash);
    return () => {
      process.off('uncaughtException', crash);
      process.off('unhandledRejection', crash);
    };
  },
  exit: (code) => process.exit(code),
};

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Runs a service until SIGTERM/SIGINT: builds it, runs it, and reruns it
 * after a backoff whenever a run fails, dies or returns. On a stop signal the
 * current run is interrupted (its finalizers run), the program is disposed and
 * the process exits 0, or 1 if that takes longer than the stop timeout. An
 * uncaught exception, an unhandled rejection or a program that can't be built
 * exits 1, and the platform starts a new container. Resolves once it called
 * `host.exit`.
 */
export function runService(program: ServiceProgram, options: RunServiceOptions = {}): Promise<void> {
  const host = options.host ?? processHost;
  const backoff = { ...BACKOFF, ...options.backoff };
  const stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const sleep = options.sleep ?? sleepFor;
  const name = process.env[SERVICE_ENV] ?? 'service';
  const job = `service:${name}`;

  installConsoleCapture();
  installFetchInstrumentation();
  emit('env', { event: 'start', runtime: 'service', name, initMs: Math.round(performance.now()) });

  const stopping = new AbortController();
  let stopSignal = 'stop';
  let forceExit: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const { promise, resolve } = Promise.withResolvers<void>();

  const offCrash = host.onCrash((error) => {
    emitError(error, 'unhandled');
    finish(1, 'crash');
  });
  const offStop = host.onStopSignal((signal) => {
    if (stopping.signal.aborted) return;
    stopSignal = signal;
    forceExit = setTimeout(() => {
      log.warn(`service ${name} did not stop within ${stopTimeoutMs / 1_000}s of ${signal}; exiting`);
      finish(1, signal);
    }, stopTimeoutMs);
    stopping.abort();
  });

  function finish(code: number, reason: string): void {
    if (finished) return;
    finished = true;
    clearTimeout(forceExit);
    offStop();
    offCrash();
    emit('env', { event: 'stop', runtime: 'service', name, reason });
    host.exit(code);
    resolve();
  }

  function dispose(): Promise<void> {
    return program.dispose().catch((error: unknown) => emitError(error, 'service', { job }));
  }

  async function main(): Promise<void> {
    try {
      await program.start(stopping.signal);
    } catch (error) {
      // A stop signal while the layer builds interrupts the build: that's a stop, not a failure.
      if (!stopping.signal.aborted) {
        emitError(error, 'service', { job });
        await dispose();
        return finish(1, 'start failed');
      }
    }
    let delay = backoff.initialMs;
    while (!stopping.signal.aborted) {
      const t0 = performance.now();
      let failure: { error: unknown } | undefined;
      try {
        await program.run(stopping.signal);
      } catch (error) {
        failure = { error };
      }
      if (stopping.signal.aborted) break;
      const dur = Math.round(performance.now() - t0);
      if (failure) emitError(failure.error, 'service', { job });
      emit('job', { kind: 'service', name, status: failure ? 'error' : 'ok', dur });
      if (dur >= backoff.resetAfterMs) delay = backoff.initialMs;
      const wait = Math.round(delay * (1 + backoff.jitter * Math.random()));
      if (!failure)
        log.warn(`service ${name}'s run returned; running it again in ${(wait / 1_000).toFixed(1)}s`);
      await sleep(wait, stopping.signal);
      delay = Math.min(delay * 2, backoff.maxMs);
    }
    await dispose();
    finish(0, stopSignal);
  }

  main().catch((error: unknown) => {
    emitError(error, 'unhandled');
    finish(1, 'crash');
  });
  return promise;
}
