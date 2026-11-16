/**
 * The control plane's HTTP API (`/v1`) as an Effect `HttpApi`: the control
 * plane implements it, the console calls it through a client generated from
 * it, and its schemas describe what the CLI sends and reads.
 *
 * Imported from `@ericminassian/platform-core/platform-api`, never from the
 * core index, so app runtimes don't load it.
 *
 * Auth is one of:
 *  - `Authorization: Bearer <platform token>` (CLI, from `plat login`)
 *  - `Authorization: Bearer <GitHub Actions OIDC token>` (CI deploys only)
 *  - the console's session cookie, plus `x-platform-csrf: 1` on writes
 *
 * The wire format predates this definition and published CLIs depend on it:
 * paths, bodies and the `{ error: { code, message } }` error body stay as
 * they are.
 */
import { Context, Schema, SchemaGetter } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema } from 'effect/http-api';
import {
  AdminOverview,
  ApiErrorBody,
  AppRecord,
  AppSummary,
  CliLoginRequest,
  CliLoginResponse,
  CostResponse,
  CreateAppRequest,
  CreateDeploymentRequest,
  CreateDeploymentResponse,
  CronRunResponse,
  DeadLetterAction,
  DeadLetterActionResponse,
  DeadLettersResponse,
  CustomMetricsResponse,
  DataCollections,
  DataPage,
  DeploymentRecord,
  EmailSending,
  EdgeFloorResponse,
  EmailStatsResponse,
  ErrorGroup,
  ErrorOccurrencesResponse,
  ErrorStatus,
  InsightsRequest,
  InsightsResponse,
  JobsResponse,
  LimitsResponse,
  LogContextResponse,
  LogLine,
  LogsResponse,
  LogStatsResponse,
  MeResponse,
  MetricsResponse,
  PutSecretRequest,
  QueueStats,
  RealtimeStatsResponse,
  RollbackRequest,
  RollbackResponse,
  RouteStats,
  SecretsResponse,
  SeriesResponse,
  ServiceActionResponse,
  ServicesResponse,
  StageDestroyed,
  StageDestroying,
  StageRecord,
  StartServiceRequest,
  StorageResponse,
  SuppressedResponse,
  TraceResponse,
  TracesResponse,
  UpdateAppRequest,
  UpdateErrorRequest,
  UptimePoint,
  UrlResponse,
} from './api.ts';
import type { MemberRole } from './config.ts';
import {
  AlertHistoryResponse,
  AlertRule,
  AlertRuleInput,
  Dashboard,
  LogFilters,
  SaveDashboardRequest,
  SavedQuery,
  SaveQueryRequest,
  SeriesQuery,
  TraceFilters,
} from './explore.ts';

// ---------------------------------------------------------------------------
// Errors: one class per status, each encoded as `{ error: { code, message } }`
// ---------------------------------------------------------------------------

const errorFields = { code: Schema.String, message: Schema.String };
type ErrorFields = { readonly code: string; readonly message: string };

/** The wire schema for an error class: its `code`/`message` nested under `error`, answered with `status`. */
const onTheWire = <
  Tag extends string,
  S extends Schema.Codec<ErrorFields, ErrorFields & { readonly _tag: Tag }>,
>(
  tag: Tag,
  error: S,
  status: number,
) =>
  ApiErrorBody.pipe(
    Schema.decodeTo(error, {
      decode: SchemaGetter.transform((body) => ({ _tag: tag, ...body.error })),
      encode: SchemaGetter.transform(({ code, message }) => ({ error: { code, message } })),
    }),
    HttpApiSchema.status(status),
  );

/** 400 `bad_request` (also every request that fails its schema). */
export class BadRequest extends Schema.TaggedError<BadRequest, { readonly brand: unique symbol }>()(
  'BadRequest',
  errorFields,
) {
  static readonly of = (message: string) => new BadRequest({ code: 'bad_request', message });
}

/** 401 `unauthenticated`: no or invalid credentials. */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated, { readonly brand: unique symbol }>()(
  'Unauthenticated',
  errorFields,
) {
  static readonly of = (message: string) => new Unauthenticated({ code: 'unauthenticated', message });
}

/** 403: `forbidden`, `members_only`, `admins_only`, `not_a_member`, `csrf`. */
export class Forbidden extends Schema.TaggedError<Forbidden, { readonly brand: unique symbol }>()(
  'Forbidden',
  errorFields,
) {}

/** 404 `not_found`. */
export class NotFound extends Schema.TaggedError<NotFound, { readonly brand: unique symbol }>()(
  'NotFound',
  errorFields,
) {
  static readonly of = (what: string) => new NotFound({ code: 'not_found', message: `${what} not found` });
}

/**
 * 409: `exists`, `dns_conflict`, `has_stages`, `already_started`, `rollback_failed`,
 * `redrive_failed`, `discard_failed`, `paused_by_aws`, `service_action_failed`.
 */
export class Conflict extends Schema.TaggedError<Conflict, { readonly brand: unique symbol }>()(
  'Conflict',
  errorFields,
) {}

/** 422 `invalid_manifest`: the deployment's `plat.config.ts` doesn't validate. */
export class InvalidManifest extends Schema.TaggedError<InvalidManifest, { readonly brand: unique symbol }>()(
  'InvalidManifest',
  errorFields,
) {
  static readonly of = (message: string) => new InvalidManifest({ code: 'invalid_manifest', message });
}

/** 429 `limit`: an app or stage limit from `platform.config.ts`. */
export class LimitReached extends Schema.TaggedError<LimitReached, { readonly brand: unique symbol }>()(
  'LimitReached',
  errorFields,
) {
  static readonly of = (message: string) => new LimitReached({ code: 'limit', message });
}

export const BadRequestError = onTheWire('BadRequest', BadRequest, 400);
export const UnauthenticatedError = onTheWire('Unauthenticated', Unauthenticated, 401);
export const ForbiddenError = onTheWire('Forbidden', Forbidden, 403);
export const NotFoundError = onTheWire('NotFound', NotFound, 404);
export const ConflictError = onTheWire('Conflict', Conflict, 409);
export const InvalidManifestError = onTheWire('InvalidManifest', InvalidManifest, 422);
export const LimitReachedError = onTheWire('LimitReached', LimitReached, 429);

/** Every API error; a 500 is a defect, answered by the platform's server wrapper. */
export type ApiError =
  | BadRequest
  | Unauthenticated
  | Forbidden
  | NotFound
  | Conflict
  | InvalidManifest
  | LimitReached;

/** Errors any endpoint may answer with. */
const errors = [
  BadRequestError,
  UnauthenticatedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InvalidManifestError,
  LimitReachedError,
] as const;

// ---------------------------------------------------------------------------
// Who is calling
// ---------------------------------------------------------------------------

export interface MemberPrincipal {
  readonly kind: 'member';
  readonly github: string;
  readonly role: MemberRole;
}

/** A GitHub Actions run, identified by its OIDC token. */
export interface CiPrincipal {
  readonly kind: 'ci';
  readonly repository: string;
  readonly repositoryOwner: string;
  readonly ref: string;
  readonly eventName: string;
  readonly sha?: string | undefined;
  readonly actor?: string | undefined;
  readonly runId?: string | undefined;
}

export type Principal = MemberPrincipal | CiPrincipal;

/** The caller, provided by `Authenticated`. */
export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()(
  '@ericminassian/platform-core/CurrentPrincipal',
) {}

/**
 * Requires a platform token, a GitHub Actions OIDC token or the console
 * cookie (with the CSRF header on writes), and provides `CurrentPrincipal`.
 * Endpoints narrow to members or admins themselves.
 */
export class Authenticated extends HttpApiMiddleware.Service<Authenticated, { provides: CurrentPrincipal }>()(
  '@ericminassian/platform-core/Authenticated',
  { error: [UnauthenticatedError, ForbiddenError] },
) {}

/** Header the console sends on every request; cross-site forms can't set it (CSRF guard). */
export const CSRF_HEADER = 'x-platform-csrf';

/**
 * Answers a request whose path, query or body fails its schema with a 400
 * `bad_request` in the API's error body, where Effect would answer an empty
 * 400. Applies to every endpoint.
 */
export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  '@ericminassian/platform-core/RequestValidation',
  { error: BadRequestError },
) {}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const app = { app: Schema.String };
const appStage = { app: Schema.String, stage: Schema.String };
/** `?stage=` defaults to prod; the server validates the name. */
const stageQuery = { stage: Schema.optional(Schema.String) };
/** `?range=1h|24h|7d|30d` or `?from=&to=` (epoch ms or ISO), and `?res=1m|1h|1d`. */
const timeQuery = {
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  range: Schema.optional(Schema.String),
  res: Schema.optional(Schema.String),
};
const rangeQuery = { ...stageQuery, ...timeQuery };
const limit = Schema.optional(Schema.Int);

export class SessionApi extends HttpApiGroup.make('session').add(
  /** Exchanges a GitHub token for a platform token (`plat login`). */
  HttpApiEndpoint.post('cliLogin', '/auth/cli', {
    payload: CliLoginRequest,
    success: CliLoginResponse,
    error: errors,
  }),
  HttpApiEndpoint.get('me', '/me', { success: MeResponse, error: errors }).middleware(Authenticated),
) {}

export class AppsApi extends HttpApiGroup.make('apps')
  .add(
    HttpApiEndpoint.get('list', '/apps', { success: Schema.Array(AppSummary), error: errors }),
    HttpApiEndpoint.post('create', '/apps', {
      payload: CreateAppRequest,
      success: AppRecord.pipe(HttpApiSchema.status(201)),
      error: errors,
    }),
    HttpApiEndpoint.get('get', '/apps/:app', { params: app, success: AppSummary, error: errors }),
    HttpApiEndpoint.patch('update', '/apps/:app', {
      params: app,
      payload: UpdateAppRequest,
      success: AppRecord,
      error: errors,
    }),
    /** Refused (409 `has_stages`) while any stage exists. */
    HttpApiEndpoint.delete('remove', '/apps/:app', {
      params: app,
      success: HttpApiSchema.NoContent,
      error: errors,
    }),
  )
  .middleware(Authenticated) {}

export class StagesApi extends HttpApiGroup.make('stages')
  .add(
    HttpApiEndpoint.get('list', '/apps/:app/stages', {
      params: app,
      success: Schema.Array(StageRecord),
      error: errors,
    }),
    /** 202 while destroying; 200 when there was nothing left. Prod needs `?confirm=<app>`. */
    HttpApiEndpoint.delete('destroy', '/apps/:app/stages/:stage', {
      params: appStage,
      query: { confirm: Schema.optional(Schema.String) },
      success: [
        StageDestroying.pipe(HttpApiSchema.status(202)),
        StageDestroyed.pipe(HttpApiSchema.status(200)),
      ],
      error: errors,
    }),
    HttpApiEndpoint.post('rollback', '/apps/:app/stages/:stage/rollback', {
      params: appStage,
      /** No body rolls back to the previous deployment. */
      payload: [RollbackRequest, Schema.Null],
      success: RollbackResponse,
      error: errors,
    }),
  )
  .middleware(Authenticated) {}

export class DeploymentsApi extends HttpApiGroup.make('deployments')
  .add(
    /** Newest first, without event logs or manifests. */
    HttpApiEndpoint.get('list', '/apps/:app/deployments', {
      params: app,
      query: { stage: Schema.optional(Schema.String), limit },
      success: Schema.Array(DeploymentRecord),
      error: errors,
    }),
    /** Records the deployment and returns presigned upload forms; `start` runs it. */
    HttpApiEndpoint.post('create', '/apps/:app/deployments', {
      params: app,
      payload: CreateDeploymentRequest,
      success: CreateDeploymentResponse.pipe(HttpApiSchema.status(201)),
      error: errors,
    }),
    HttpApiEndpoint.get('get', '/deployments/:id', {
      params: { id: Schema.String },
      success: DeploymentRecord,
      error: errors,
    }),
    HttpApiEndpoint.post('start', '/deployments/:id/start', {
      params: { id: Schema.String },
      success: DeploymentRecord.pipe(HttpApiSchema.status(202)),
      error: errors,
    }),
  )
  .middleware(Authenticated) {}

/** A live log line, or the error that ended the tail. */
export const TailEvent = Schema.Union([
  Schema.Struct({ event: Schema.Literal('line'), data: Schema.fromJsonString(LogLine) }),
  Schema.Struct({ event: Schema.Literal('error'), data: Schema.String }),
]);

export class ObserveApi extends HttpApiGroup.make('observe')
  .add(
    HttpApiEndpoint.get('metrics', '/apps/:app/metrics', {
      params: app,
      query: rangeQuery,
      success: MetricsResponse,
      error: errors,
    }),
    HttpApiEndpoint.get('routes', '/apps/:app/routes', {
      params: app,
      query: rangeQuery,
      success: Schema.Array(RouteStats),
      error: errors,
    }),
    HttpApiEndpoint.get('jobs', '/apps/:app/jobs', {
      params: app,
      query: rangeQuery,
      success: JobsResponse,
      error: errors,
    }),
    HttpApiEndpoint.get('queues', '/apps/:app/queues', {
      params: app,
      query: stageQuery,
      success: Schema.Array(QueueStats),
      error: errors,
    }),
    /** The stage's dead-letter queue: every job that failed its last attempt. */
    HttpApiEndpoint.get('deadLetters', '/apps/:app/dead-letters', {
      params: app,
      query: stageQuery,
      success: DeadLettersResponse,
      error: errors,
    }),
    /** AppSync Events activity of the stage's channel namespace, from CloudWatch. */
    HttpApiEndpoint.get('realtime', '/apps/:app/realtime', {
      params: app,
      query: rangeQuery,
      success: RealtimeStatsResponse,
      error: errors,
    }),
    /** The stage's sender, SES sending status, today's usage, and SES counts for its tenant. */
    HttpApiEndpoint.get('email', '/apps/:app/email', {
      params: app,
      query: rangeQuery,
      success: EmailStatsResponse,
      error: errors,
    }),
    /** `Metrics.count`/`value` series per name, at 1h or 1d. */
    HttpApiEndpoint.get('customMetrics', '/apps/:app/custom-metrics', {
      params: app,
      query: rangeQuery,
      success: CustomMetricsResponse,
      error: errors,
    }),
    /** `RateLimits` checks per limit: allowed and denied, at 1h or 1d. */
    HttpApiEndpoint.get('limits', '/apps/:app/limits', {
      params: app,
      query: rangeQuery,
      success: LimitsResponse,
      error: errors,
    }),
    /** The stage's long-running services: ECS state, CPU and memory, starts and failed runs. */
    HttpApiEndpoint.get('services', '/apps/:app/services', {
      params: app,
      query: rangeQuery,
      success: ServicesResponse,
      error: errors,
    }),
    HttpApiEndpoint.get('errors', '/apps/:app/errors', {
      params: app,
      query: { ...stageQuery, status: Schema.optional(ErrorStatus) },
      success: Schema.Array(ErrorGroup),
      error: errors,
    }),
    HttpApiEndpoint.patch('updateError', '/apps/:app/errors/:fingerprint', {
      params: { ...app, fingerprint: Schema.String },
      query: stageQuery,
      payload: UpdateErrorRequest,
      success: UpdateErrorRequest,
      error: errors,
    }),
    HttpApiEndpoint.get('uptime', '/apps/:app/uptime', {
      params: app,
      query: rangeQuery,
      success: Schema.Array(UptimePoint),
      error: errors,
    }),
    HttpApiEndpoint.get('cost', '/apps/:app/cost', {
      params: app,
      query: { days: Schema.optional(Schema.Int) },
      success: CostResponse,
      error: errors,
    }),
    /** Logs Insights search; `next` pages on. */
    HttpApiEndpoint.get('logs', '/apps/:app/logs', {
      params: app,
      query: {
        ...rangeQuery,
        q: Schema.optional(Schema.String),
        /** `web`, `worker` or `service:<name>`. */
        stream: Schema.optional(Schema.String),
        /** Structured filters as JSON (`LogFilters`); any of them runs the search on Logs Insights. */
        f: Schema.optional(Schema.fromJsonString(LogFilters)),
        limit,
        next: Schema.optional(Schema.String),
      },
      success: LogsResponse,
      error: errors,
    }),
    /**
     * Server-sent events: `line` (a `LogLine` as JSON) as logs arrive, `error` if
     * the tail fails. A comment every 20 s keeps the connection open: CloudFront
     * drops origin connections that stay idle.
     */
    HttpApiEndpoint.get('tail', '/apps/:app/logs/tail', {
      params: app,
      query: {
        ...stageQuery,
        q: Schema.optional(Schema.String),
        /** `web`, `worker` or `service:<name>`. */
        stream: Schema.optional(Schema.String),
        /** Structured filters as JSON (`LogFilters`), applied to the live lines. */
        f: Schema.optional(Schema.fromJsonString(LogFilters)),
      },
      success: HttpApiSchema.StreamSse({ events: TailEvent, keepAlive: '20 seconds' }),
      error: errors,
    }),
    HttpApiEndpoint.get('trace', '/apps/:app/traces/:trace', {
      params: { ...app, trace: Schema.String },
      query: rangeQuery,
      success: TraceResponse,
      error: errors,
    }),
    /**
     * The explorer's query (`SeriesQuery`, as JSON in `q`) over the range. `res`
     * may also be `5m`, `10m`, `15m` or `30m` (sums of minute rollups); by
     * default about 150 buckets.
     */
    HttpApiEndpoint.get('series', '/apps/:app/series', {
      params: app,
      query: { ...rangeQuery, q: Schema.fromJsonString(SeriesQuery) },
      success: SeriesResponse,
      error: errors,
    }),
    /** Requests and jobs that started traces, newest first (Logs Insights over their root lines). */
    HttpApiEndpoint.get('traces', '/apps/:app/traces', {
      params: app,
      query: { ...rangeQuery, f: Schema.optional(Schema.fromJsonString(TraceFilters)), limit },
      success: TracesResponse,
      error: errors,
    }),
    /** Lines per bucket by level and the commonest field values, for the same search as `logs` (Logs Insights). */
    HttpApiEndpoint.get('logStats', '/apps/:app/logs/stats', {
      params: app,
      query: {
        ...rangeQuery,
        q: Schema.optional(Schema.String),
        stream: Schema.optional(Schema.String),
        f: Schema.optional(Schema.fromJsonString(LogFilters)),
      },
      success: LogStatsResponse,
      error: errors,
    }),
    /** The lines just before and after one line (`ts`, epoch ms) of one stream. */
    HttpApiEndpoint.get('logContext', '/apps/:app/logs/context', {
      params: app,
      query: {
        ...stageQuery,
        stream: Schema.String,
        ts: Schema.String,
        before: limit,
        after: limit,
      },
      success: LogContextResponse,
      error: errors,
    }),
    /** Runs a Logs Insights query on the stage's log groups and waits for it (up to 25 s). */
    HttpApiEndpoint.post('insights', '/apps/:app/insights', {
      params: app,
      payload: InsightsRequest,
      success: InsightsResponse,
      error: errors,
    }),
    /** An error group's events over the range (Logs Insights). */
    HttpApiEndpoint.get('errorOccurrences', '/apps/:app/errors/:fingerprint/occurrences', {
      params: { ...app, fingerprint: Schema.String },
      query: rangeQuery,
      success: ErrorOccurrencesResponse,
      error: errors,
    }),
  )
  .middleware(Authenticated) {}

/** Named explorer, log and trace queries of an app, shared by everyone who can see it. */
export class QueriesApi extends HttpApiGroup.make('queries')
  .add(
    HttpApiEndpoint.get('list', '/apps/:app/queries', {
      params: app,
      success: Schema.Array(SavedQuery),
      error: errors,
    }),
    HttpApiEndpoint.post('create', '/apps/:app/queries', {
      params: app,
      payload: SaveQueryRequest,
      success: SavedQuery.pipe(HttpApiSchema.status(201)),
      error: errors,
    }),
    HttpApiEndpoint.put('update', '/apps/:app/queries/:id', {
      params: { ...app, id: Schema.String },
      payload: SaveQueryRequest,
      success: SavedQuery,
      error: errors,
    }),
    HttpApiEndpoint.delete('remove', '/apps/:app/queries/:id', {
      params: { ...app, id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: errors,
    }),
  )
  .middleware(Authenticated) {}

/**
 * Dashboards: widgets on a 12-column grid. One with an `app` belongs to that
 * app (members who can see it); one without spans apps, and each widget's
 * data still needs access to its own app.
 */
export class DashboardsApi extends HttpApiGroup.make('dashboards')
  .add(
    HttpApiEndpoint.get('list', '/dashboards', {
      query: { app: Schema.optional(Schema.String) },
      success: Schema.Array(Dashboard),
      error: errors,
    }),
    HttpApiEndpoint.post('create', '/dashboards', {
      payload: SaveDashboardRequest,
      success: Dashboard.pipe(HttpApiSchema.status(201)),
      error: errors,
    }),
    HttpApiEndpoint.get('get', '/dashboards/:id', {
      params: { id: Schema.String },
      success: Dashboard,
      error: errors,
    }),
    HttpApiEndpoint.put('update', '/dashboards/:id', {
      params: { id: Schema.String },
      payload: SaveDashboardRequest,
      success: Dashboard,
      error: errors,
    }),
    HttpApiEndpoint.delete('remove', '/dashboards/:id', {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: errors,
    }),
  )
  .middleware(Authenticated) {}

/** Alert rules on an app's stages, evaluated every minute by the control plane. */
export class AlertsApi extends HttpApiGroup.make('alerts')
  .add(
    /** Every stage's rules, or `?stage=`'s. */
    HttpApiEndpoint.get('list', '/apps/:app/alerts', {
      params: app,
      query: { stage: Schema.optional(Schema.String) },
      success: Schema.Array(AlertRule),
      error: errors,
    }),
    HttpApiEndpoint.post('create', '/apps/:app/alerts', {
      params: app,
      payload: AlertRuleInput,
      success: AlertRule.pipe(HttpApiSchema.status(201)),
      error: errors,
    }),
    /** Replaces the rule's settings; a changed query or condition starts it over in `no_data`. */
    HttpApiEndpoint.put('update', '/apps/:app/alerts/:id', {
      params: { ...app, id: Schema.String },
      payload: AlertRuleInput,
      success: AlertRule,
      error: errors,
    }),
    HttpApiEndpoint.delete('remove', '/apps/:app/alerts/:id', {
      params: { ...app, id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: errors,
    }),
    /** State changes of the app's rules (or `?stage=`'s) in the range, newest first. */
    HttpApiEndpoint.get('history', '/apps/:app/alerts/history', {
      params: app,
      query: { stage: Schema.optional(Schema.String), ...timeQuery },
      success: AlertHistoryResponse,
      error: errors,
    }),
  )
  .middleware(Authenticated) {}

/** `?scope=shared` targets the app-wide secret; otherwise the stage (`?stage=`, default prod). */
const secretQuery = { ...stageQuery, scope: Schema.optional(Schema.Literals(['shared', 'stage'])) };

export class ManageApi extends HttpApiGroup.make('manage')
  .add(
    HttpApiEndpoint.get('collections', '/apps/:app/data/collections', {
      params: app,
      query: stageQuery,
      success: DataCollections,
      error: errors,
    }),
    HttpApiEndpoint.get('items', '/apps/:app/data/items', {
      params: app,
      query: {
        ...stageQuery,
        collection: Schema.String,
        partition: Schema.optional(Schema.String),
        cursor: Schema.optional(Schema.String),
        limit,
      },
      success: DataPage,
      error: errors,
    }),
    HttpApiEndpoint.get('storage', '/apps/:app/storage', {
      params: app,
      query: {
        ...stageQuery,
        store: Schema.optional(Schema.String),
        prefix: Schema.optional(Schema.String),
        cursor: Schema.optional(Schema.String),
      },
      success: StorageResponse,
      error: errors,
    }),
    HttpApiEndpoint.get('storageUrl', '/apps/:app/storage/url', {
      params: app,
      query: { ...stageQuery, store: Schema.String, key: Schema.String },
      success: UrlResponse,
      error: errors,
    }),
    HttpApiEndpoint.get('secrets', '/apps/:app/secrets', {
      params: app,
      query: stageQuery,
      success: SecretsResponse,
      error: errors,
    }),
    HttpApiEndpoint.put('putSecret', '/apps/:app/secrets/:name', {
      params: { ...app, name: Schema.String },
      query: secretQuery,
      payload: PutSecretRequest,
      success: HttpApiSchema.NoContent,
      error: errors,
    }),
    HttpApiEndpoint.delete('deleteSecret', '/apps/:app/secrets/:name', {
      params: { ...app, name: Schema.String },
      query: secretQuery,
      success: HttpApiSchema.NoContent,
      error: errors,
    }),
    HttpApiEndpoint.post('runCron', '/apps/:app/crons/:name/run', {
      params: { ...app, name: Schema.String },
      query: stageQuery,
      success: CronRunResponse.pipe(HttpApiSchema.status(202)),
      error: errors,
    }),
    /** The stage's suppression list (its SES tenant's), in SES's order; `next` pages on. */
    HttpApiEndpoint.get('suppressed', '/apps/:app/email/suppressed', {
      params: app,
      query: { ...stageQuery, next: Schema.optional(Schema.String) },
      success: SuppressedResponse,
      error: errors,
    }),
    /** Lets SES send to `address` from this stage again. */
    HttpApiEndpoint.delete('unsuppress', '/apps/:app/email/suppressed/:address', {
      params: { ...app, address: Schema.String },
      query: stageQuery,
      success: HttpApiSchema.NoContent,
      error: errors,
    }),
    /** Resumes sending after a pause by the reputation policy or by hand (not one by AWS). */
    HttpApiEndpoint.post('resumeEmail', '/apps/:app/email/resume', {
      params: app,
      query: stageQuery,
      success: EmailSending,
      error: errors,
    }),
    /** Replaces the service's task with a fresh one on the same build. */
    HttpApiEndpoint.post('restartService', '/apps/:app/services/:name/restart', {
      params: { ...app, name: Schema.String },
      query: stageQuery,
      success: ServiceActionResponse.pipe(HttpApiSchema.status(202)),
      error: errors,
    }),
    /**
     * Runs it (desired 1). It stops again after `minutes` when given; on
     * previews always, by default after its `previewMinutes` (30 when that is 0).
     */
    HttpApiEndpoint.post('startService', '/apps/:app/services/:name/start', {
      params: { ...app, name: Schema.String },
      query: stageQuery,
      payload: StartServiceRequest,
      success: ServiceActionResponse.pipe(HttpApiSchema.status(202)),
      error: errors,
    }),
    /** Scales it to zero until it is started again or the stage is redeployed. */
    HttpApiEndpoint.post('stopService', '/apps/:app/services/:name/stop', {
      params: { ...app, name: Schema.String },
      query: stageQuery,
      success: ServiceActionResponse.pipe(HttpApiSchema.status(202)),
      error: errors,
    }),
    /** Runs dead letters again from their first attempt, on the function their handler runs in now. */
    HttpApiEndpoint.post('redrive', '/apps/:app/dead-letters/redrive', {
      params: app,
      query: stageQuery,
      payload: DeadLetterAction,
      success: DeadLetterActionResponse,
      error: errors,
    }),
    HttpApiEndpoint.post('discard', '/apps/:app/dead-letters/discard', {
      params: app,
      query: stageQuery,
      payload: DeadLetterAction,
      success: DeadLetterActionResponse,
      error: errors,
    }),
  )
  .middleware(Authenticated) {}

export class AdminApi extends HttpApiGroup.make('admin')
  .add(HttpApiEndpoint.get('overview', '/admin/overview', { success: AdminOverview, error: errors }))
  /** The edge's per-client request floor: on or off, blocked and allowed requests, recently blocked ones. */
  .add(
    HttpApiEndpoint.get('edge', '/admin/edge', {
      query: timeQuery,
      success: EdgeFloorResponse,
      error: errors,
    }),
  )
  .middleware(Authenticated) {}

export class PlatformApi extends HttpApi.make('platform')
  .add(SessionApi)
  .add(AppsApi)
  .add(StagesApi)
  .add(DeploymentsApi)
  .add(ObserveApi)
  .add(QueriesApi)
  .add(DashboardsApi)
  .add(AlertsApi)
  .add(ManageApi)
  .add(AdminApi)
  .prefix('/v1')
  // After every group: `middleware` only reaches the endpoints added so far.
  .middleware(RequestValidation) {}
