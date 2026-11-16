/**
 * Alert rules, evaluated every minute (the worker's `alerts` cron). Each
 * enabled rule on a live stage reads its window from minute rollups
 * (`TelemetryQuery.seriesWindow`), moves its state with `nextAlertState`,
 * keeps a history row of every change, and emails the alerts topic when a
 * `notify` rule fires or recovers. A platform without rules does one read.
 *
 * Writes follow change: a rule whose value and state stay the same is
 * recorded again only every `RECORD_EVERY_MS`, so a quiet app's rules cost
 * reads, not writes.
 */
import { PublishCommand } from '@aws-sdk/client-sns';
import {
  ALERT_LAG_MINUTES,
  type AlertEvent,
  type AlertRule,
  type AlertState,
  describeQuery,
  nextAlertState,
  seriesUnit,
} from '@ericminassian/platform-core';
import { Clock, Context, Effect, Exit, Layer } from 'effect';
import { Aws, tryAws } from '../aws.ts';
import { Settings } from '../config.ts';
import { type Patch, Store } from '../store.ts';
import { TelemetryQuery } from '../telemetry/query.ts';
import { AlertRules } from './rules.ts';

/** How often a rule whose state and value didn't change is recorded anyway, so `evaluatedAt` shows it runs. */
export const RECORD_EVERY_MS = 10 * 60_000;

/** Rules evaluated at once. */
const CONCURRENCY = 8;

/**
 * The window an evaluation at `now` reads: the `minutes` whole minutes that
 * end `ALERT_LAG_MINUTES` before the current one, so their telemetry is in.
 */
export function alertWindow(now: number, minutes: number): { readonly from: number; readonly to: number } {
  const to = (Math.floor(now / 60_000) - ALERT_LAG_MINUTES) * 60_000;
  return { from: to - minutes * 60_000, to };
}

export interface AlertNotification {
  readonly subject: string;
  readonly message: string;
}

export interface AlertDecision {
  readonly state: AlertState;
  /** What to record on the rule; none when nothing changed since a recent record. */
  readonly patch: Patch<AlertRule> | undefined;
  /** The history row, when the state changes. */
  readonly event: AlertEvent | undefined;
  /** The email, when a `notify` rule goes into alarm or out of it. */
  readonly notification: AlertNotification | undefined;
}

const STATE_LABEL: Record<AlertState, string> = { alarm: 'ALARM', ok: 'OK', no_data: 'NO DATA' };

const UNIT_SUFFIX: Record<string, string> = { percent: '%', ms: ' ms', per_second: '/s' };

/** A value as an alert shows it: whole numbers as they are, others to two decimals. */
export const formatAlertValue = (v: number): string =>
  Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);

/** What a rule watches, as a subject line ends: `5xx % of requests above 2 over 5 min`. */
export function describeRule(rule: Pick<AlertRule, 'query' | 'condition'>): string {
  const { op, threshold, minutes } = rule.condition;
  return `${describeQuery(rule.query)} ${op} ${formatAlertValue(threshold)} over ${minutes} min`;
}

/** The email for a rule's change from `from` to `to` (pure). */
export function alertNotification(
  rule: AlertRule,
  from: AlertState,
  to: AlertState,
  value: number | null,
  window: { readonly to: number },
  consoleUrl: string,
): AlertNotification {
  const unit = UNIT_SUFFIX[seriesUnit(rule.query)] ?? '';
  const until = new Date(window.to).toISOString().slice(11, 16);
  const headline =
    to === 'alarm'
      ? `${rule.name} is firing.`
      : to === 'ok'
        ? `${rule.name} is back to normal.`
        : `${rule.name} has no data${from === 'alarm' ? ', so it is no longer firing' : ''}.`;
  // SNS takes a subject of at most 100 printable ASCII characters.
  const subject = `[${STATE_LABEL[to]}] ${rule.app}/${rule.stage}: ${describeRule(rule)}`
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, 100);
  return {
    subject,
    message: [
      headline,
      '',
      `${describeQuery(rule.query)}, ${rule.condition.minutes} min to ${until} UTC: ${
        value === null ? 'no data' : `${formatAlertValue(value)}${unit}`
      }`,
      `Fires when ${rule.condition.op} ${formatAlertValue(rule.condition.threshold)}${unit}.`,
      '',
      `${consoleUrl}/apps/${rule.app}/alerts?stage=${encodeURIComponent(rule.stage)}`,
    ].join('\n'),
  };
}

/**
 * What an evaluation of `rule` at `now` that read `value` does (pure): the
 * state it moves to, what to record, the history row of a change, and the
 * email of a `notify` rule going into alarm or out of it.
 */
export function decideAlert(
  rule: AlertRule,
  value: number | null,
  now: number,
  consoleUrl: string,
): AlertDecision {
  const state = nextAlertState(rule.state, value, rule);
  const changed = state !== rule.state;
  const at = new Date(now).toISOString();
  const due =
    changed ||
    rule.value === undefined ||
    rule.value !== value ||
    !rule.evaluatedAt ||
    now - Date.parse(rule.evaluatedAt) >= RECORD_EVERY_MS;
  return {
    state,
    patch: due ? { state, value, evaluatedAt: at, ...(changed ? { stateSince: at } : {}) } : undefined,
    event: changed
      ? {
          ts: at,
          rule: rule.id,
          name: rule.name,
          stage: rule.stage,
          from: rule.state,
          to: state,
          value,
          threshold: rule.condition.threshold,
        }
      : undefined,
    notification:
      changed && rule.notify && (state === 'alarm' || rule.state === 'alarm')
        ? alertNotification(
            rule,
            rule.state,
            state,
            value,
            alertWindow(now, rule.condition.minutes),
            consoleUrl,
          )
        : undefined,
  };
}

export class AlertEvaluator extends Context.Service<
  AlertEvaluator,
  {
    /** Evaluates every enabled rule on a live stage; fails when any of them couldn't be. */
    readonly run: Effect.Effect<{ readonly rules: number; readonly changed: number }>;
  }
>()('@ericminassian/platform-control-plane/AlertEvaluator') {
  static readonly layer: Layer.Layer<
    AlertEvaluator,
    never,
    AlertRules | Aws | Settings | Store | TelemetryQuery
  > = Layer.effect(
    AlertEvaluator,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const rules = yield* AlertRules;
      const settings = yield* Settings;
      const store = yield* Store;
      const telemetry = yield* TelemetryQuery;

      const publish = Effect.fnUntraced(function* (n: AlertNotification) {
        const { alertsTopicArn } = yield* settings.runtime;
        if (!alertsTopicArn) return;
        yield* tryAws(() =>
          aws
            .sns()
            .send(new PublishCommand({ TopicArn: alertsTopicArn, Subject: n.subject, Message: n.message })),
        ).pipe(Effect.orDie);
      });

      /** Evaluates one rule; answers whether its state changed. */
      const evaluate = Effect.fnUntraced(function* (rule: AlertRule, now: number) {
        const { from, to } = alertWindow(now, rule.condition.minutes);
        const value = yield* telemetry.seriesWindow(rule.app, rule.stage, rule.query, from, to);
        const decision = decideAlert(rule, value, now, settings.consoleUrl);
        if (!decision.patch) return false;
        // Conditional on the state read: of two overlapping runs, only one moves it and notifies.
        if (!(yield* rules.record(rule, decision.patch)) || !decision.event) return false;
        // The state has moved; a failed history row or email fails the run (each tried either way).
        const event = decision.event;
        const notification = decision.notification;
        const done = yield* Effect.all(
          [
            Effect.exit(rules.addEvent(rule.app, event)),
            Effect.exit(notification ? publish(notification) : Effect.void),
          ],
          { concurrency: 2 },
        );
        yield* Exit.asVoidAll(done);
        return true;
      });

      const run = Effect.gen(function* () {
        const enabled = (yield* rules.listAll).filter((r) => r.enabled);
        if (enabled.length === 0) return { rules: 0, changed: 0 };
        const live = new Set(
          (yield* store.listAllStages)
            .filter((s) => s.status !== 'destroyed')
            .map((s) => `${s.app}#${s.stage}`),
        );
        const due = enabled.filter((r) => live.has(`${r.app}#${r.stage}`));
        const now = yield* Clock.currentTimeMillis;
        const results = yield* Effect.forEach(
          due,
          (rule) =>
            Effect.exit(
              evaluate(rule, now).pipe(
                Effect.tapCause((cause) =>
                  Effect.logError('could not evaluate an alert rule', cause).pipe(
                    Effect.annotateLogs({ app: rule.app, stage: rule.stage, rule: rule.id }),
                  ),
                ),
              ),
            ),
          { concurrency: CONCURRENCY },
        );
        yield* Exit.asVoidAll(results);
        return {
          rules: due.length,
          changed: results.filter((r) => Exit.isSuccess(r) && r.value).length,
        };
      }).pipe(Effect.withSpan('AlertEvaluator.run'));

      return AlertEvaluator.of({ run });
    }),
  );
}
