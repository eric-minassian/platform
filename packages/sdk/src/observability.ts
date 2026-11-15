import { format } from 'node:util';
import { Cause, ErrorReporter, Layer, Logger, type LogLevel, References } from 'effect';
import { currentContext, recordError } from './runtime/context.ts';
import { emit, emitError } from './runtime/telemetry.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel.LogLevel, Level | undefined> = {
  All: 'debug',
  Trace: 'debug',
  Debug: 'debug',
  Info: 'info',
  Warn: 'warn',
  Error: 'error',
  Fatal: 'error',
  None: undefined,
};

/**
 * `Effect.log*` as platform `log` lines: annotations become fields, so they're
 * searchable in `plat logs`. An error-level log with a failure in its cause
 * also records an error group, like `log.error(msg, err)`.
 */
const platformLogger = Logger.make<unknown, void>(({ message, logLevel, cause, fiber }) => {
  const level = LEVELS[logLevel];
  if (!level) return;
  const parts = Array.isArray(message) ? message : [message];
  const fields: Record<string, unknown> = { ...fiber.getRef(References.CurrentLogAnnotations) };
  const error = Cause.prettyErrors(cause)[0];
  if (error) fields.error = { name: error.name, message: error.message, stack: error.stack };
  emit('log', { ...fields, level, msg: format(...parts) });
  if (error && level === 'error') {
    const ctx = currentContext();
    emitError(error, 'log', {
      ...(ctx?.route ? { route: ctx.route } : {}),
      ...(ctx?.job ? { job: ctx.job } : {}),
    });
  }
});

/**
 * Hands the error behind a failed request to the SDK's server wrapper, which
 * reports a 5xx with it (real stack, one error group) instead of a bare
 * `HTTP 500`. Errors marked `ErrorReporter.ignore`, such as a request body
 * that fails its schema (a 400), are skipped.
 */
const requestErrors: ErrorReporter.ErrorReporter = {
  [ErrorReporter.TypeId]: ErrorReporter.TypeId,
  report({ cause }) {
    for (const reason of cause.reasons) {
      if (Cause.isInterruptReason(reason)) continue;
      const original = Cause.isDieReason(reason) ? reason.defect : reason.error;
      if (ErrorReporter.isIgnored(original)) continue;
      const pretty = Cause.prettyErrors(Cause.fromReasons([reason]))[0];
      recordError(pretty ?? original, { defect: Cause.isDieReason(reason) });
    }
  },
};

/** Platform logging and error reporting. `toFetchHandler` and `defineWorker` include it. */
export const observability: Layer.Layer<never> = Layer.mergeAll(
  Logger.layer([platformLogger]),
  ErrorReporter.layer([requestErrors]),
);
