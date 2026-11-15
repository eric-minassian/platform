/**
 * Uptime pinger (every 5 minutes): hits `/__platform/health` on every active
 * prod stage, records the result, and alerts on up→down (after two failed
 * checks in a row) and down→up transitions. For prod stages that send email
 * it also reads SES's sending status, and alerts when SES pauses or resumes it.
 */
import { PublishCommand } from '@aws-sdk/client-sns';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { type EmailSending, HEALTH_PATH, PROD_STAGE, telemetryKeys } from '@ericminassian/platform-core';
import { Clock, Context, Effect, Layer, Option } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { Aws, tryAws } from '../aws.ts';
import { Settings } from '../config.ts';
import { AppEmail } from '../email.ts';
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

/** Next email state for a stage given the stored one and what SES says now (pure). */
export function nextEmailState(
  prevPaused: boolean | undefined,
  sending: EmailSending,
): { paused: boolean; transition: 'paused' | 'resumed' | null } {
  const paused = sending.status === 'paused';
  // Nothing stored counts as sending, so a stage first seen paused alerts.
  const wasPaused = prevPaused === true;
  return { paused, transition: paused === wasPaused ? null : paused ? 'paused' : 'resumed' };
}

/** The alert for an email transition: subject and body. */
export function emailAlert(
  s: Pick<StageItem, 'app' | 'stage'>,
  sending: EmailSending,
  consoleUrl: string,
): { subject: string; message: string } {
  const page = `${consoleUrl}/apps/${s.app}/email`;
  if (sending.status === 'enabled') {
    return {
      subject: `[platform] ${s.app} email is sending again`,
      message: `SES lets ${s.app} (${s.stage}) send email again.\n\n${page}`,
    };
  }
  const by =
    sending.pausedBy === 'aws'
      ? 'AWS paused'
      : sending.pausedBy === 'manual'
        ? 'Someone paused'
        : 'The reputation policy paused';
  const next =
    sending.pausedBy === 'aws'
      ? 'Only AWS Support can lift this pause: reply to the case AWS opened in the Support Center.'
      : `Once the cause is fixed, resume with \`plat email resume --app ${s.app}\` or in the console.`;
  return {
    subject: `[platform] ${s.app} email is PAUSED`,
    message: [
      `${by} ${s.app}'s email (${s.stage})${sending.since ? ` at ${sending.since}` : ''}.`,
      ...(sending.cause ? [`Cause: ${sending.cause}`] : []),
      next,
      '',
      page,
    ].join('\n'),
  };
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
  static readonly layer: Layer.Layer<
    Pinger,
    never,
    Aws | AppEmail | Settings | Store | HttpClient.HttpClient
  > = Layer.effect(
    Pinger,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const email = yield* AppEmail;
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

      const alert = (subject: string, message: string) =>
        Effect.gen(function* () {
          const { alertsTopicArn } = yield* settings.runtime;
          if (!alertsTopicArn) return;
          yield* tryAws(() =>
            aws
              .sns()
              .send(new PublishCommand({ TopicArn: alertsTopicArn, Subject: subject, Message: message })),
          );
        });

      /** Records SES's sending status for a prod stage that sends email, and alerts when it changes. */
      const checkEmail = Effect.fnUntraced(function* (s: StageItem) {
        const live = s.currentDeployment ? yield* store.getDeployment(s.currentDeployment) : Option.none();
        if (!Option.exists(live, (d) => d.manifest?.email !== undefined)) {
          // A stage that stopped sending email has no pause to remember.
          if (s.emailPaused !== undefined)
            yield* store.updateStage(s.app, s.stage, { emailPaused: undefined, emailChangedAt: undefined });
          return;
        }
        // None while the stage's tenant doesn't exist yet.
        const sending = yield* email.sending(s.app, s.stage);
        if (Option.isNone(sending)) return;
        const next = nextEmailState(s.emailPaused, sending.value);
        // Alert before recording the change, so an alert that fails to send is retried next time.
        if (next.transition) {
          const { subject, message } = emailAlert(s, sending.value, settings.consoleUrl);
          yield* alert(subject, message);
        }
        if (next.paused !== s.emailPaused) {
          const ts = yield* Clock.currentTimeMillis;
          yield* store.updateStage(s.app, s.stage, {
            emailPaused: next.paused,
            ...(next.transition ? { emailChangedAt: new Date(ts).toISOString() } : {}),
          });
        }
      });

      const checkStage = Effect.fnUntraced(function* (s: StageItem) {
        const { telemetryTable } = yield* settings.runtime;
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
        if (next.transition) {
          const what = next.transition === 'down' ? 'DOWN' : 'back UP';
          yield* alert(
            `[platform] ${s.app} is ${what}`,
            `${s.url}${HEALTH_PATH} → ${result.status || 'no response'} in ${result.ms}ms\n\n${settings.consoleUrl}/apps/${s.app}`,
          );
        }
        // SES being unreadable (throttled, or a permission missing) must not stop the uptime checks.
        yield* checkEmail(s).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning('could not check email sending', cause).pipe(
              Effect.annotateLogs({ app: s.app, stage: s.stage }),
            ),
          ),
        );
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
