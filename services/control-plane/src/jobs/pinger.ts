/**
 * Uptime pinger (every 5 minutes): hits `/__platform/health` on every active
 * prod stage, records the result, and alerts on up→down (after two failed
 * checks in a row) and down→up transitions.
 */
import { PublishCommand } from '@aws-sdk/client-sns';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { HEALTH_PATH, PROD_STAGE, telemetryKeys } from '@ericminassian/platform-core';
import { Clock, Context, Effect, Layer } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { Aws, tryAws } from '../aws.ts';
import { Settings } from '../config.ts';
import { type StageItem, Store } from '../store.ts';

const UPTIME_TTL_DAYS = 35;
const FAILURES_BEFORE_DOWN = 2;

export interface CheckResult {
  readonly ok: boolean;
  readonly status: number;
  readonly ms: number;
}

/** Next up/down state for a stage given its stored state and a new result (pure). */
export function nextUptimeState(
  prev: { readonly up?: boolean | undefined; readonly failures?: number | undefined },
  ok: boolean,
): { up: boolean; failures: number; transition: 'down' | 'up' | null } {
  if (ok) return { up: true, failures: 0, transition: prev.up === false ? 'up' : null };
  const failures = (prev.failures ?? 0) + 1;
  const down = failures >= FAILURES_BEFORE_DOWN;
  const wasUp = prev.up !== false;
  return { up: !down && wasUp, failures, transition: down && wasUp ? 'down' : null };
}

export class Pinger extends Context.Service<
  Pinger,
  {
    /** One health check: 2xx is up; a redirect, an error status or no answer within 10 s is not. */
    check(url: string): Effect.Effect<CheckResult>;
    /** Checks every active prod stage; answers how many were checked and which apps are down. */
    readonly run: Effect.Effect<{ readonly checked: number; readonly down: ReadonlyArray<string> }>;
  }
>()('@ericminassian/platform-control-plane/Pinger') {
  static readonly layer: Layer.Layer<Pinger, never, Aws | Settings | Store | HttpClient.HttpClient> =
    Layer.effect(
      Pinger,
      Effect.gen(function* () {
        const aws = yield* Aws;
        const settings = yield* Settings;
        const store = yield* Store;
        const http = yield* HttpClient.HttpClient;

        const check = Effect.fn('Pinger.check')(function* (url: string) {
          const started = yield* Clock.currentTimeMillis;
          const status = yield* http.get(`${url}${HEALTH_PATH}`).pipe(
            Effect.tap((res) => Effect.ignore(res.text)),
            Effect.map((res) => res.status),
            Effect.timeout('10 seconds'),
            // A health endpoint that redirects is misrouted, not up.
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
            Effect.orElseSucceed(() => 0),
          );
          const ms = (yield* Clock.currentTimeMillis) - started;
          return { ok: status >= 200 && status < 300, status, ms } satisfies CheckResult;
        });

        const checkStage = Effect.fnUntraced(function* (s: StageItem) {
          const { telemetryTable, alertsTopicArn } = yield* settings.runtime;
          const result = yield* check(s.url);
          const ts = yield* Clock.currentTimeMillis;
          yield* tryAws(() =>
            aws.ddb().send(
              new PutCommand({
                TableName: telemetryTable,
                Item: {
                  pk: telemetryKeys.uptime(s.app, s.stage),
                  sk: telemetryKeys.time(ts),
                  ...result,
                  ttl: Math.floor(ts / 1000) + UPTIME_TTL_DAYS * 86_400,
                },
              }),
            ),
          );
          const next = nextUptimeState(s, result.ok);
          if (next.up !== s.up || next.failures !== (s.failures ?? 0)) {
            yield* store.updateStage(s.app, s.stage, {
              up: next.up,
              failures: next.failures,
              ...(next.transition ? { upChangedAt: new Date(ts).toISOString() } : {}),
            });
          }
          if (next.transition && alertsTopicArn) {
            const what = next.transition === 'down' ? 'DOWN' : 'back UP';
            yield* tryAws(() =>
              aws.sns().send(
                new PublishCommand({
                  TopicArn: alertsTopicArn,
                  Subject: `[platform] ${s.app} is ${what}`,
                  Message: `${s.url}${HEALTH_PATH} → ${result.status || 'no response'} in ${result.ms}ms\n\n${settings.consoleUrl}/apps/${s.app}`,
                }),
              ),
            );
          }
          return next.up;
        });

        const run = Effect.gen(function* () {
          const stages = (yield* store.listAllStages).filter(
            (s) => s.stage === PROD_STAGE && s.status === 'active',
          );
          const up = yield* Effect.forEach(stages, checkStage, { concurrency: 8 });
          return { checked: stages.length, down: stages.filter((_, i) => !up[i]).map((s) => s.app) };
        }).pipe(Effect.orDie, Effect.withSpan('Pinger.run'));

        return Pinger.of({ check, run });
      }),
    );
}
