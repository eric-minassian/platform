/**
 * Uptime (every 5 minutes) for every active prod stage, without waking servers
 * that have nothing to do. A Web Function bills the memory it holds for an
 * environment's whole life, about 5 minutes after its last request, so a
 * 5-minute health check kept every prod server warm all month and cold-started
 * most checks.
 *
 * - **From traffic.** A stage that served requests in the last 10 complete
 *   minutes (its whole-stage minute rollups) is up unless at least 3 were
 *   served and half or more were 5xx. No request is sent.
 * - **Health checks.** A GET of `/__platform/health` for a stage that served
 *   nothing: one without a server every run (the router answers it at the
 *   edge, no function runs); one with a server when its newest uptime row is
 *   6 hours old, or is traffic (it just went quiet, which is also how a server
 *   that can no longer start looks), and every run while its last result
 *   failed, so two failures in a row still take 10 minutes and a recovery is
 *   seen. Otherwise nothing is recorded and its up/down state stays.
 * - **Never** a check of the control plane's own app, whose worker this is.
 *
 * Each result is an uptime row; two failed results in a row are DOWN and
 * alert, and a success after that alerts back up. For prod stages that send
 * email it also reads SES's sending status, and alerts when SES pauses or
 * resumes it.
 */
import { PublishCommand } from '@aws-sdk/client-sns';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  bucketStart,
  type EmailSending,
  HEALTH_PATH,
  PROD_STAGE,
  platformNames,
  telemetryKeys,
  type UptimeCheck,
  type UptimePoint,
  type UptimeTraffic,
} from '@ericminassian/platform-core';
import { Clock, Context, Effect, Layer, Option } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { Aws, tryAws } from '../aws.ts';
import { Settings } from '../config.ts';
import { AppEmail } from '../email.ts';
import { type DeploymentItem, type StageItem, Store } from '../store.ts';
import { TelemetryQuery } from '../telemetry/query.ts';

const UPTIME_TTL_DAYS = 35;
const FAILURES_BEFORE_DOWN = 2;
/** The complete minutes of a stage's own requests that stand for a check. */
export const TRAFFIC_WINDOW_MINUTES = 10;
/** Fewest requests in the window that can count as down. */
const MIN_REQUESTS_FOR_DOWN = 3;
/** How often a quiet stage with a server gets a health check. */
export const QUIET_CHECK_EVERY_MS = 6 * 3_600_000;

export interface CheckResult {
  readonly ok: boolean;
  readonly status: number;
  readonly ms: number;
}

/** One uptime result as the pinger records it: a row without its time. */
export type UptimeResult = Omit<UptimeCheck, 'ts'> | Omit<UptimeTraffic, 'ts'>;

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

/** A stage's requests in the window as a result (pure); none when it served nothing. */
export function trafficResult(req: number, s5xx: number): Omit<UptimeTraffic, 'ts'> | undefined {
  if (req <= 0) return undefined;
  return { source: 'traffic', ok: !(req >= MIN_REQUESTS_FOR_DOWN && s5xx * 2 >= req), req, s5xx };
}

/** Whether a prod stage that served nothing in the window gets a health check now (pure; see the module docs). */
export function needsCheck(input: {
  readonly app: string;
  /** Its live deployment has a server. */
  readonly server: boolean;
  readonly stage: Pick<StageItem, 'up' | 'failures'>;
  /** Its newest uptime row. */
  readonly last: Pick<UptimePoint, 'ts' | 'source'> | undefined;
  readonly now: number;
}): boolean {
  const { app, server, stage, last, now } = input;
  if (app === platformNames.controlPlaneApp) return false;
  if (!server) return true;
  if ((stage.failures ?? 0) > 0 || stage.up === false) return true;
  if (!last || last.source === 'traffic') return true;
  return now - Date.parse(last.ts) >= QUIET_CHECK_EVERY_MS;
}

/** What a result says, for an alert (pure). */
export function describeResult(url: string, r: UptimeResult): string {
  if (r.source === 'check') return `${url}${HEALTH_PATH} → ${r.status || 'no response'} in ${r.ms}ms`;
  return `${r.s5xx} of ${r.req} requests in the last ${TRAFFIC_WINDOW_MINUTES} minutes were 5xx`;
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
    /** Every active prod stage; answers how many there were and which apps are down. */
    readonly run: Effect.Effect<{ readonly checked: number; readonly down: ReadonlyArray<string> }>;
  }
>()('@ericminassian/platform-control-plane/Pinger') {
  static readonly layer: Layer.Layer<
    Pinger,
    never,
    Aws | AppEmail | Settings | Store | TelemetryQuery | HttpClient.HttpClient
  > = Layer.effect(
    Pinger,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const email = yield* AppEmail;
      const settings = yield* Settings;
      const store = yield* Store;
      const telemetry = yield* TelemetryQuery;
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
      const checkEmail = Effect.fnUntraced(function* (s: StageItem, live: DeploymentItem | undefined) {
        if (live?.manifest?.email === undefined) {
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

      /** This run's result for a stage, if it gets one (see the module docs). */
      const observe = Effect.fnUntraced(function* (s: StageItem, server: boolean, now: number) {
        if (server) {
          const end = bucketStart(now, '1m');
          const { points } = yield* telemetry.metrics(s.app, s.stage, {
            from: end - TRAFFIC_WINDOW_MINUTES * 60_000,
            to: end - 1,
            res: '1m',
          });
          const traffic = trafficResult(
            points.reduce((a, p) => a + p.req, 0),
            points.reduce((a, p) => a + p.s5xx, 0),
          );
          if (traffic) return Option.some<UptimeResult>(traffic);
        }
        const last = server ? Option.getOrUndefined(yield* telemetry.lastUptime(s.app, s.stage)) : undefined;
        if (!needsCheck({ app: s.app, server, stage: s, last, now })) return Option.none<UptimeResult>();
        return Option.some<UptimeResult>({ source: 'check', ...(yield* check(s.url)) });
      });

      const checkStage = Effect.fnUntraced(function* (s: StageItem) {
        const { telemetryTable } = yield* settings.runtime;
        const live = s.currentDeployment
          ? Option.getOrUndefined(yield* store.getDeployment(s.currentDeployment))
          : undefined;
        // The route names a Web Function endpoint only when there's a server: the answer when the
        // live deployment can't be read.
        const server = live?.manifest ? Boolean(live.manifest.web?.server) : s.route?.o !== undefined;
        // A stage with no route (no web, no public stores) has nothing at the edge to answer.
        const result = s.route
          ? yield* observe(s, server, yield* Clock.currentTimeMillis)
          : Option.none<UptimeResult>();
        let up = s.up !== false;
        if (Option.isSome(result)) {
          const r = result.value;
          const ts = yield* Clock.currentTimeMillis;
          yield* tryAws(() =>
            aws.ddb().send(
              new PutCommand({
                TableName: telemetryTable,
                Item: {
                  pk: telemetryKeys.uptime(s.app, s.stage),
                  sk: telemetryKeys.time(ts),
                  ...r,
                  ttl: Math.floor(ts / 1000) + UPTIME_TTL_DAYS * 86_400,
                },
              }),
            ),
          );
          const next = nextUptimeState(s, r.ok);
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
              `${describeResult(s.url, r)}\n\n${settings.consoleUrl}/apps/${s.app}`,
            );
          }
          up = next.up;
        }
        // SES being unreadable (throttled, or a permission missing) must not stop the uptime checks.
        yield* checkEmail(s, live).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning('could not check email sending', cause).pipe(
              Effect.annotateLogs({ app: s.app, stage: s.stage }),
            ),
          ),
        );
        return up;
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
