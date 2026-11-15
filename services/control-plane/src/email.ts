/**
 * Email (SES): what the console, `plat email` and the pinger read of a
 * stage's sending, and the two things they can change. Each stage that
 * declares `email` is an SES tenant (`names.emailTenant`): SES keeps its
 * suppression list, reports its metrics, and pauses it on its own when the
 * tenant's reputation policy finds its bounces or complaints too high.
 */
import {
  DeleteSuppressedDestinationCommand,
  GetReputationEntityCommand,
  GetTenantCommand,
  ListSuppressedDestinationsCommand,
  type ReputationEntity,
  type StatusRecord,
  type SuppressedDestinationSummary,
  UpdateReputationEntityCustomerManagedStatusCommand,
} from '@aws-sdk/client-sesv2';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  type EmailPoint,
  type EmailRuntimeConfig,
  type EmailSending,
  type EmailStatsResponse,
  emailDailyLimit,
  emailFromAddress,
  emailUsageDay,
  formatMailbox,
  names,
  type ResolvedManifest,
  type SuppressedAddress,
  type SuppressedResponse,
  telemetryKeys,
} from '@ericminassian/platform-core';
import { BadRequest, Conflict, NotFound } from '@ericminassian/platform-core/platform-api';
import { Clock, Context, Effect, Layer, Option } from 'effect';
import { Aws, AwsError, tryAws } from './aws.ts';
import { cloudWatchRange, denseSeries, readMetrics, sumQueries } from './cloudwatch.ts';
import { Settings } from './config.ts';
import type { TimeRange } from './telemetry/query.ts';

/** A stage's sender, SES tenant and daily limit. */
export interface StageEmail {
  /** `"Todo" <todo@mail…>`, or the bare address. */
  readonly from: string;
  readonly tenant: string;
  /** Recipients per UTC day. */
  readonly dailyLimit: number;
}

/**
 * The stage's email as its live deployment declares it, on the platform's
 * mail domain; undefined when the deployment declares none or the platform
 * predates email (pure).
 */
export function stageEmail(
  app: string,
  stage: string,
  email: ResolvedManifest['email'],
  runtime: EmailRuntimeConfig | undefined,
): StageEmail | undefined {
  if (!email || !runtime) return undefined;
  return {
    from: formatMailbox(emailFromAddress(app, stage, runtime.domain), email.name),
    tenant: names.emailTenant(app, stage),
    dailyLimit: emailDailyLimit(stage, email.dailyLimit),
  };
}

/**
 * The `Cause` SES records when someone sets the customer-managed status
 * (from SES's console, the CLI or the API). A reputation policy's pause sets
 * the same status with its own cause.
 */
export const MANUAL_PAUSE_CAUSE = 'Status manually updated.';

/**
 * Whether SES lets a tenant send, and who stopped it (pure).
 *
 * - `AwsSesManagedStatus` is only ever changed by AWS (Trust & Safety). A
 *   pause there holds whatever the customer-managed status says, and only
 *   AWS Support can lift it.
 * - The reputation policy, and anyone pausing by hand, set
 *   `CustomerManagedStatus`; setting it to `REINSTATED` resumes sending even
 *   while findings are open.
 * - A tenant nobody has paused has neither record.
 */
export function toEmailSending(entity: ReputationEntity | undefined): EmailSending {
  const aws = entity?.AwsSesManagedStatus;
  if (aws?.Status === 'DISABLED') return paused('aws', aws);
  const customer = entity?.CustomerManagedStatus;
  if (customer?.Status === 'DISABLED')
    return paused(customer.Cause === MANUAL_PAUSE_CAUSE ? 'manual' : 'policy', customer);
  return { status: 'enabled' };
}

const paused = (pausedBy: NonNullable<EmailSending['pausedBy']>, record: StatusRecord): EmailSending => ({
  status: 'paused',
  pausedBy,
  ...(record.Cause ? { cause: record.Cause } : {}),
  ...(record.LastUpdatedTimestamp ? { since: record.LastUpdatedTimestamp.toISOString() } : {}),
});

/** SES's per-tenant metrics, and the series each is. */
export const EMAIL_METRICS: ReadonlyArray<readonly [keyof Omit<EmailPoint, 'ts'>, string]> = [
  ['sends', 'Send'],
  ['deliveries', 'Delivery'],
  ['bounces', 'Bounce'],
  ['complaints', 'Complaint'],
];

/** One `Sum` query per metric for the tenant, ids `m<index into EMAIL_METRICS>`. */
export function emailQueries(tenant: { readonly name: string; readonly id: string }, range: TimeRange) {
  // SES publishes tenant metrics with both dimensions, and CloudWatch matches the whole set.
  return sumQueries(
    'AWS/SES',
    EMAIL_METRICS.map(([, metric]) => metric),
    [
      { Name: 'TenantId', Value: tenant.id },
      { Name: 'TenantName', Value: tenant.name },
    ],
    range,
  );
}

/** One entry of a suppression list as the API shows it (pure). */
export function toSuppressedAddress(s: SuppressedDestinationSummary): SuppressedAddress {
  return {
    address: s.EmailAddress ?? '',
    reason: s.Reason === 'COMPLAINT' ? 'complaint' : 'bounce',
    since: (s.LastUpdateTime ?? new Date(0)).toISOString(),
  };
}

/** Addresses per page of a suppression list. */
export const SUPPRESSED_PAGE_SIZE = 100;

export class AppEmail extends Context.Service<
  AppEmail,
  {
    /**
     * The stage's sender, sending status, today's usage and SES's counts over
     * `range`; `enabled: false` (and empty series) when it declares no `email`.
     */
    stats(
      app: string,
      stage: string,
      email: ResolvedManifest['email'],
      range: TimeRange,
    ): Effect.Effect<EmailStatsResponse>;
    /** Whether SES lets the stage send; none while it has no tenant. */
    sending(app: string, stage: string): Effect.Effect<Option.Option<EmailSending>, AwsError>;
    /** A page of the stage's suppression list; `next` continues from an earlier page. */
    suppressed(
      app: string,
      stage: string,
      next: string | undefined,
    ): Effect.Effect<SuppressedResponse, BadRequest | NotFound>;
    /** Lets SES send to `address` from the stage again. */
    unsuppress(app: string, stage: string, address: string): Effect.Effect<void, NotFound>;
    /**
     * Lifts a pause by the reputation policy or by hand, and answers the
     * state the stage is then in (the current one when it isn't paused).
     */
    resume(app: string, stage: string): Effect.Effect<EmailSending, Conflict | NotFound>;
  }
>()('@ericminassian/platform-control-plane/AppEmail') {
  static readonly layer: Layer.Layer<AppEmail, never, Aws | Settings> = Layer.effect(
    AppEmail,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;

      const noTenant = AwsError.is('NotFoundException');

      /**
       * The tenant's ARN and id, which the reputation and metric calls need;
       * none while it doesn't exist (its first deploy is running, or the stage
       * was destroyed). Looked up once per call: a destroyed and redeployed
       * stage gets a new tenant id.
       */
      const tenant = (name: string) =>
        tryAws(() => aws.sesv2().send(new GetTenantCommand({ TenantName: name }))).pipe(
          Effect.map(({ Tenant: t }) =>
            t?.TenantArn && t.TenantId
              ? Option.some({ name, arn: t.TenantArn, id: t.TenantId })
              : Option.none(),
          ),
          Effect.catchIf(noTenant, () => Effect.succeedNone),
        );

      const reputation = (arn: string) =>
        tryAws(() =>
          aws.sesv2().send(
            new GetReputationEntityCommand({
              ReputationEntityType: 'RESOURCE',
              ReputationEntityReference: arn,
            }),
          ),
        ).pipe(Effect.map((res) => toEmailSending(res.ReputationEntity)));

      /** Recipients the SDK counted today (UTC) against the stage's limit. */
      const sentToday = Effect.fnUntraced(function* (app: string, stage: string, now: number) {
        const { telemetryTable } = yield* settings.runtime;
        const res = yield* tryAws(() =>
          aws.ddb().send(
            new GetCommand({
              TableName: telemetryTable,
              Key: { pk: telemetryKeys.email(app, stage), sk: emailUsageDay(now) },
              ProjectionExpression: '#n',
              ExpressionAttributeNames: { '#n': 'n' },
            }),
          ),
        );
        return Number(res.Item?.n ?? 0);
      });

      const series = (results: Parameters<typeof denseSeries>[0], range: TimeRange) =>
        denseSeries(
          results,
          range,
          EMAIL_METRICS.map(([s]) => s),
        );

      const stats = Effect.fn('AppEmail.stats')(function* (
        app: string,
        stage: string,
        email: ResolvedManifest['email'],
        requested: TimeRange,
      ) {
        const now = yield* Clock.currentTimeMillis;
        const range = cloudWatchRange(requested, now);
        const facts = stageEmail(app, stage, email, (yield* settings.runtime).email);
        if (!facts) {
          return {
            app,
            stage,
            enabled: false,
            res: range.res,
            ...series([], range),
          } satisfies EmailStatsResponse;
        }
        const [found, sent] = yield* Effect.all([tenant(facts.tenant), sentToday(app, stage, now)], {
          concurrency: 'unbounded',
        });
        const known = {
          app,
          stage,
          enabled: true,
          from: facts.from,
          today: { sent, limit: facts.dailyLimit },
          res: range.res,
        } as const;
        // Without a tenant there's no status to read and nothing has been sent.
        if (Option.isNone(found)) return { ...known, ...series([], range) } satisfies EmailStatsResponse;
        const [sending, results] = yield* Effect.all(
          [reputation(found.value.arn), readMetrics(aws, emailQueries(found.value, range), range)],
          { concurrency: 'unbounded' },
        );
        return { ...known, sending, ...series(results, range) } satisfies EmailStatsResponse;
      }, Effect.orDie);

      const sending = Effect.fn('AppEmail.sending')(function* (app: string, stage: string) {
        const found = yield* tenant(names.emailTenant(app, stage));
        if (Option.isNone(found)) return Option.none<EmailSending>();
        return Option.some(yield* reputation(found.value.arn));
      });

      const suppressed = Effect.fn('AppEmail.suppressed')(function* (
        app: string,
        stage: string,
        next: string | undefined,
      ) {
        const name = names.emailTenant(app, stage);
        const res = yield* tryAws(() =>
          aws.sesv2().send(
            new ListSuppressedDestinationsCommand({
              TenantName: name,
              PageSize: SUPPRESSED_PAGE_SIZE,
              ...(next ? { NextToken: next } : {}),
            }),
          ),
        ).pipe(
          Effect.catchTag('AwsError', (e): Effect.Effect<never, BadRequest | NotFound> => {
            if (noTenant(e)) return Effect.fail(NotFound.of(`email tenant ${name}`));
            // SES's answer to a token it didn't issue (or one that expired).
            if (AwsError.is('InvalidNextTokenException')(e))
              return Effect.fail(BadRequest.of('`next` is not a token from an earlier page'));
            return Effect.die(e);
          }),
        );
        return {
          items: (res.SuppressedDestinationSummaries ?? []).map(toSuppressedAddress),
          ...(res.NextToken ? { next: res.NextToken } : {}),
        } satisfies SuppressedResponse;
      });

      const unsuppress = Effect.fn('AppEmail.unsuppress')(function* (
        app: string,
        stage: string,
        address: string,
      ) {
        yield* tryAws(() =>
          aws.sesv2().send(
            new DeleteSuppressedDestinationCommand({
              EmailAddress: address,
              TenantName: names.emailTenant(app, stage),
            }),
          ),
        ).pipe(
          Effect.catchTag('AwsError', (e) =>
            noTenant(e)
              ? Effect.fail(
                  new NotFound({
                    code: 'not_found',
                    message: `${address} is not on ${app}/${stage}'s suppression list`,
                  }),
                )
              : Effect.die(e),
          ),
        );
      });

      const resume = Effect.fn('AppEmail.resume')(function* (app: string, stage: string) {
        const name = names.emailTenant(app, stage);
        const found = yield* tenant(name).pipe(Effect.orDie);
        if (Option.isNone(found)) return yield* NotFound.of(`email tenant ${name}`);
        const current = yield* reputation(found.value.arn).pipe(Effect.orDie);
        if (current.status === 'enabled') return current;
        if (current.pausedBy === 'aws') {
          // Reinstating the customer-managed status would succeed and change nothing.
          return yield* new Conflict({
            code: 'paused_by_aws',
            message: `AWS paused sending for ${app}/${stage}${current.cause ? ` (${current.cause})` : ''}; only AWS Support can lift it, through the case AWS opened in the Support Center`,
          });
        }
        // REINSTATED rather than ENABLED: the policy would pause it again while its findings are open.
        yield* tryAws(() =>
          aws.sesv2().send(
            new UpdateReputationEntityCustomerManagedStatusCommand({
              ReputationEntityType: 'RESOURCE',
              ReputationEntityReference: found.value.arn,
              SendingStatus: 'REINSTATED',
            }),
          ),
        ).pipe(Effect.orDie);
        return { status: 'enabled' } satisfies EmailSending;
      });

      return AppEmail.of({ stats, sending, suppressed, unsuppress, resume });
    }),
  );
}
