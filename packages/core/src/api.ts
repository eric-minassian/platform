/**
 * Control plane API records and payloads, as schemas: the control plane
 * encodes responses and decodes requests with them, the console and the CLI
 * read the same shapes. The endpoints themselves are `PlatformApi`
 * (`@ericminassian/platform-core/platform-api`). All routes live under `/v1`.
 *
 * Optional fields accept `undefined`, so a record built with spreads of
 * possibly-missing values encodes; JSON drops them either way.
 */
import { Schema, SchemaGetter } from 'effect';
import { MemberRole } from './config.ts';
import { QueryResolution } from './explore.ts';
import { ResolvedManifest } from './manifest.ts';
import { Resolution, TelemetryEvent } from './telemetry.ts';
import { WEB_COMPUTE, WEB_COMPUTE_SETTINGS } from './web-compute.ts';

const optional = Schema.optional;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** A GitHub repository's visibility, as its Actions OIDC tokens state it. */
export const RepoVisibility = Schema.Literals(['public', 'private', 'internal']);
export type RepoVisibility = typeof RepoVisibility.Type;

export const AppRecord = Schema.Struct({
  name: Schema.String,
  /** GitHub `owner/name` allowed to deploy this app from CI. */
  repo: Schema.String,
  /**
   * The repo's visibility at its last CI deploy (absent before one): the
   * public directory links a public repo. Changing `repo` forgets it.
   */
  repoVisibility: optional(RepoVisibility),
  description: optional(Schema.String),
  /** GitHub usernames who can manage the app (admins can manage everything). */
  owners: Schema.Array(Schema.String),
  createdBy: Schema.String,
  createdAt: Schema.String,
});
export type AppRecord = typeof AppRecord.Type;

export const StageStatus = Schema.Literals(['active', 'deploying', 'failed', 'destroying', 'destroyed']);
export type StageStatus = typeof StageStatus.Type;

/** How a server runs (`WebCompute`). */
export const WebComputeMode = Schema.Literals(WEB_COMPUTE);

/** Days in a row the other mode was cheaper enough to switch to (`ComputeStreak`). */
export const ComputeStreakSchema = Schema.Struct({
  to: WebComputeMode,
  days: Schema.Finite,
  day: Schema.String,
});

/** A prod stage's monthly cost in each mode, estimated daily from its traffic (`simulateWebCompute`). */
export const ComputeEstimate = Schema.Struct({
  at: Schema.String,
  request: Schema.Struct({ monthlyUsd: Schema.Finite, coldStartsPerMonth: Schema.Finite }),
  instance: Schema.Struct({ monthlyUsd: Schema.Finite, environmentHoursPerMonth: Schema.Finite }),
  requestsPerMonth: Schema.Finite,
  /** Days of traffic the month is extrapolated from. */
  days: Schema.Finite,
});
export type ComputeEstimate = typeof ComputeEstimate.Type;

export const StageRecord = Schema.Struct({
  app: Schema.String,
  stage: Schema.String,
  host: Schema.String,
  url: Schema.String,
  status: StageStatus,
  preview: Schema.Boolean,
  currentDeployment: optional(Schema.String),
  previousDeployment: optional(Schema.String),
  /** The server builds: Web Function revision ids, or request-mode function versions. */
  currentRevision: optional(Schema.String),
  previousRevision: optional(Schema.String),
  /** How the live deployment's server runs. */
  compute: optional(WebComputeMode),
  /** Prod stages with a server: what each mode would cost a month. */
  computeEstimate: optional(ComputeEstimate),
  /** Set while the other mode is cheaper enough; at three days the platform switches. */
  computeStreak: optional(ComputeStreakSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type StageRecord = typeof StageRecord.Type;

export const DeploymentStatus = Schema.Literals([
  'awaiting_upload',
  'queued',
  'running',
  'succeeded',
  'failed',
  'rolled_back',
]);
export type DeploymentStatus = typeof DeploymentStatus.Type;

export const DeploymentEventEntry = Schema.Struct({
  ts: Schema.Finite,
  level: Schema.Literals(['info', 'warn', 'error']),
  msg: Schema.String,
  /** Resource the step acted on, e.g. `table foo--prod`. */
  resource: optional(Schema.String),
});
export type DeploymentEventEntry = typeof DeploymentEventEntry.Type;

export const DeploymentRecord = Schema.Struct({
  id: Schema.String,
  app: Schema.String,
  stage: Schema.String,
  status: DeploymentStatus,
  /** GitHub username, `ci:<repo>` for OIDC deploys, or `platform` for a compute switch. */
  actor: Schema.String,
  commit: optional(Schema.String),
  ref: optional(Schema.String),
  message: optional(Schema.String),
  /** The `@ericminassian/platform` version its bundles were built with; absent before 0.4.0. */
  sdk: optional(Schema.String),
  manifest: optional(ResolvedManifest),
  /** How it runs the server. */
  compute: optional(WebComputeMode),
  /**
   * A switch of the server's mode that the platform made (actor `platform`):
   * the deployment whose build this one runs again, in `compute`.
   */
  computeSwitchOf: optional(Schema.String),
  url: optional(Schema.String),
  error: optional(Schema.String),
  events: Schema.Array(DeploymentEventEntry),
  createdAt: Schema.String,
  startedAt: optional(Schema.String),
  finishedAt: optional(Schema.String),
});
export type DeploymentRecord = typeof DeploymentRecord.Type;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const MeResponse = Schema.Struct({ github: Schema.String, role: MemberRole });
export type MeResponse = typeof MeResponse.Type;

export const CliLoginRequest = Schema.Struct({
  /** A GitHub token for the user (e.g. `gh auth token`); used once to identify them. */
  githubToken: Schema.String.check(Schema.isNonEmpty({ message: 'githubToken is required' })),
});
export type CliLoginRequest = typeof CliLoginRequest.Type;

export const CliLoginResponse = Schema.Struct({
  token: Schema.String,
  github: Schema.String,
  role: MemberRole,
  expiresAt: Schema.String,
});
export type CliLoginResponse = typeof CliLoginResponse.Type;

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

/** GitHub `owner/name`. */
export const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const Repo = Schema.Trim.check(Schema.isPattern(REPO_PATTERN, { message: 'repo must be "owner/name"' }));
/** Longer descriptions are cut to 200 characters rather than refused. */
const Description = Schema.String.pipe(
  Schema.decode({
    decode: SchemaGetter.transform((s: string) => s.slice(0, 200)),
    encode: SchemaGetter.transform((s: string) => s),
  }),
);

export const CreateAppRequest = Schema.Struct({
  /** Checked against the naming rules and reserved names by the server. */
  name: Schema.Trim,
  repo: Repo,
  description: optional(Description),
});
export type CreateAppRequest = typeof CreateAppRequest.Type;

export const UpdateAppRequest = Schema.Struct({
  description: optional(Description),
  repo: optional(Repo),
  /** The server removes duplicates. */
  owners: optional(
    Schema.Array(Schema.String).check(Schema.isMinLength(1, { message: 'owners must be a non-empty list' })),
  ),
});
export type UpdateAppRequest = typeof UpdateAppRequest.Type;

export const AppHealth = Schema.Struct({
  up: Schema.NullOr(Schema.Boolean),
  reqPerMin: Schema.Finite,
  errorRate: Schema.Finite,
  p95: Schema.NullOr(Schema.Finite),
});
export type AppHealth = typeof AppHealth.Type;

export const AppSummary = Schema.Struct({
  app: AppRecord,
  stages: Schema.Array(StageRecord),
  /** Prod health over the last hour (null when there is no prod stage). */
  health: Schema.NullOr(AppHealth),
  costMonthToDateUsd: optional(Schema.Finite),
  lastDeployment: optional(DeploymentRecord),
  /** Prod's requests in each of the last 24 hours, oldest first (absent without a prod stage). */
  traffic: optional(Schema.Array(Schema.Finite)),
  /** The app's alert rules on every stage: how many there are and how many are firing. */
  alerts: optional(Schema.Struct({ total: Schema.Finite, alarm: Schema.Finite })),
  /** Whether the public directory lists prod: its live deployment's `listed` (absent without one). */
  listed: optional(Schema.Boolean),
  /** Hosts in platform.config.ts `hosts` that serve prod; the first is the app's public URL's. */
  hosts: optional(Schema.Array(Schema.String)),
});
export type AppSummary = typeof AppSummary.Type;

// ---------------------------------------------------------------------------
// Public directory
// ---------------------------------------------------------------------------

/** Days of traffic the public directory gives each app. */
export const PUBLIC_DIRECTORY_DAYS = 30;

/** An app in the public directory: its prod stage, as anyone may see it. */
export const PublicApp = Schema.Struct({
  name: Schema.String,
  /** The live deployment's `description` in plat.config.ts, else the app's own. */
  description: optional(Schema.String),
  url: Schema.String,
  /** The GitHub repository's page, when the repo is public. */
  source: optional(Schema.String),
  /** When prod was first deployed. */
  liveSince: Schema.String,
  /** When the deployment prod serves went live (a compute switch keeps its build's time). */
  lastDeployedAt: Schema.String,
  /** Whether prod was up at the uptime pinger's last result; null before its first. */
  up: Schema.NullOr(Schema.Boolean),
  /** Pages the router served for prod's host on each of `days` (`isPageView`); today's so far. */
  pageViews: Schema.Array(Schema.Finite),
  /** Every request the router served for it on each of `days`: files, server and stores. */
  requests: Schema.Array(Schema.Finite),
});
export type PublicApp = typeof PublicApp.Type;

/** Every app whose live prod deployment is `listed` (the default), by name. */
export const PublicAppsResponse = Schema.Struct({
  generatedAt: Schema.String,
  /** The UTC days the counts cover (`YYYY-MM-DD`), oldest first, ending today (so far). */
  days: Schema.Array(Schema.String),
  /**
   * The first UTC day the router's access log counted (`YYYY-MM-DD`): days
   * before it have no counts, rather than no traffic. Absent where the
   * platform has no access log (`plat dev`).
   */
  countingSince: optional(Schema.String),
  apps: Schema.Array(PublicApp),
});
export type PublicAppsResponse = typeof PublicAppsResponse.Type;

// ---------------------------------------------------------------------------
// Stages and deployments
// ---------------------------------------------------------------------------

export const ArtifactFile = Schema.Literals(['manifest.json', 'server.zip', 'worker.zip', 'static.zip']);
export type ArtifactFile = typeof ArtifactFile.Type;

export const PresignedPost = Schema.Struct({
  url: Schema.String,
  fields: Schema.Record(Schema.String, Schema.String),
});
export type PresignedPost = typeof PresignedPost.Type;

export const CreateDeploymentRequest = Schema.Struct({
  stage: Schema.String,
  /**
   * The evaluated `plat.config.ts` (`ManifestInput`). The server validates it
   * with `parseManifest` and answers 422 with every issue when it's invalid.
   */
  manifest: Schema.Unknown,
  /** Which artifacts the CLI will upload (manifest.json is always uploaded). */
  files: optional(Schema.Array(ArtifactFile)),
  commit: optional(Schema.String),
  ref: optional(Schema.String),
  message: optional(Schema.String),
  /** The `@ericminassian/platform` version the bundles were built with (`MIN_SDK_VERSION`). */
  sdk: optional(Schema.String),
});
export type CreateDeploymentRequest = typeof CreateDeploymentRequest.Encoded;

export const CreateDeploymentResponse = Schema.Struct({
  deployment: DeploymentRecord,
  /** A form for each artifact the request listed, plus `manifest.json`. */
  uploads: Schema.Struct({
    'manifest.json': optional(PresignedPost),
    'server.zip': optional(PresignedPost),
    'worker.zip': optional(PresignedPost),
    'static.zip': optional(PresignedPost),
  }),
});
export type CreateDeploymentResponse = typeof CreateDeploymentResponse.Type;

export const RollbackRequest = Schema.Struct({
  /** Default: the stage's previous deployment. */
  deploymentId: optional(Schema.String),
});
export type RollbackRequest = typeof RollbackRequest.Type;

export const RollbackResponse = Schema.Struct({
  /** The deployment the stage routes to now. */
  currentDeployment: Schema.String,
  url: Schema.String,
});
export type RollbackResponse = typeof RollbackResponse.Type;

/** Answered with 202: the stage is being torn down. */
export const StageDestroying = Schema.Struct({ status: Schema.Literal('destroying') });
/** Answered with 200: there was nothing left to destroy. */
export const StageDestroyed = Schema.Struct({ status: Schema.Literal('destroyed') });
export const DestroyStageResponse = Schema.Union([StageDestroying, StageDestroyed]);
export type DestroyStageResponse = typeof DestroyStageResponse.Type;

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export const MetricsPoint = Schema.Struct({
  ts: Schema.String,
  req: Schema.Finite,
  s2xx: Schema.Finite,
  s3xx: Schema.Finite,
  s4xx: Schema.Finite,
  s5xx: Schema.Finite,
  p50: Schema.NullOr(Schema.Finite),
  p95: Schema.NullOr(Schema.Finite),
  p99: Schema.NullOr(Schema.Finite),
  cold: Schema.Finite,
});
export type MetricsPoint = typeof MetricsPoint.Type;

export const MetricsResponse = Schema.Struct({
  app: Schema.String,
  stage: Schema.String,
  res: Resolution,
  points: Schema.Array(MetricsPoint),
});
export type MetricsResponse = typeof MetricsResponse.Type;

export const RouteStats = Schema.Struct({
  route: Schema.String,
  method: Schema.String,
  req: Schema.Finite,
  s5xx: Schema.Finite,
  s4xx: Schema.Finite,
  p50: Schema.NullOr(Schema.Finite),
  p95: Schema.NullOr(Schema.Finite),
});
export type RouteStats = typeof RouteStats.Type;

export const JobKind = Schema.Literals(['queue', 'event', 'cron', 'invoke']);
export type JobKind = typeof JobKind.Type;

export const JobStats = Schema.Struct({
  kind: JobKind,
  name: Schema.String,
  ok: Schema.Finite,
  error: Schema.Finite,
  p95: Schema.NullOr(Schema.Finite),
  lastRun: optional(Schema.String),
});
export type JobStats = typeof JobStats.Type;

export const JobsResponse = Schema.Struct({
  jobs: Schema.Array(JobStats),
  crons: Schema.Array(Schema.Struct({ name: Schema.String, schedule: Schema.String })),
});
export type JobsResponse = typeof JobsResponse.Type;

/** A queue's jobs that aren't running: waiting for their time, and given up on. */
export const QueueStats = Schema.Struct({
  name: Schema.String,
  /** Retries and delayed sends scheduled for later. */
  scheduled: Schema.Finite,
  /** Its messages in the stage's dead-letter queue (of those `deadLetters` reads). */
  deadLetter: Schema.Finite,
});
export type QueueStats = typeof QueueStats.Type;

/** One message in the stage's dead-letter queue (core `readDeadLetter`). */
export const DeadLetterItem = Schema.Struct({
  /** The SQS message id: what redrive and discard take. */
  id: Schema.String,
  /** `unknown`: a message the platform didn't write; it can only be discarded. */
  kind: Schema.Literals(['queue', 'event', 'cron', 'invoke', 'unknown']),
  name: Schema.String,
  attempts: Schema.NullOr(Schema.Finite),
  error: Schema.Struct({ name: Schema.String, message: Schema.String }),
  /** ISO time, when the writer recorded one. */
  failedAt: Schema.NullOr(Schema.String),
  /** Who gave up on it: the SDK, Lambda, Scheduler or EventBridge. */
  source: Schema.Literals(['sdk', 'lambda', 'scheduler', 'eventbridge', 'unknown']),
  /** The message body, event detail or invoke payload, as JSON, cut to a few hundred chars. */
  preview: Schema.String,
});
export type DeadLetterItem = typeof DeadLetterItem.Type;

export const DeadLettersResponse = Schema.Struct({
  /** Messages in the queue (SQS's approximate count). */
  total: Schema.Finite,
  /** Up to `DEAD_LETTERS_READ` of them. */
  items: Schema.Array(DeadLetterItem),
});
export type DeadLettersResponse = typeof DeadLettersResponse.Type;

/** How many dead letters the API reads for a list. */
export const DEAD_LETTERS_READ = 100;

/** Redrive or discard: the given dead letters, or (no `ids`) all of them. */
export const DeadLetterAction = Schema.Struct({ ids: Schema.optional(Schema.Array(Schema.String)) });
export type DeadLetterAction = typeof DeadLetterAction.Encoded;

export const DeadLetterActionResponse = Schema.Struct({ count: Schema.Finite });
export type DeadLetterActionResponse = typeof DeadLetterActionResponse.Type;

/** Per-namespace AppSync Events counts in one bucket (CloudWatch `Sum`s). */
export const RealtimePoint = Schema.Struct({
  ts: Schema.String,
  /** Events published (`InboundMessages`; each 5 KB counts once). */
  events: Schema.Finite,
  /** Successful publish requests (up to 5 events each). */
  publishes: Schema.Finite,
  /** Successful subscribes. */
  subscribes: Schema.Finite,
  /** Publishes and subscribes refused or failed (client and server errors). */
  errors: Schema.Finite,
});
export type RealtimePoint = typeof RealtimePoint.Type;

/**
 * A stage's realtime activity. AppSync reports deliveries (`OutboundMessages`)
 * and connections only for the whole Event API, not per namespace, so they
 * can't be shown per app.
 */
export const RealtimeStatsResponse = Schema.Struct({
  app: Schema.String,
  stage: Schema.String,
  /** False when the live deployment declares no `realtime`; the rest is then empty. */
  enabled: Schema.Boolean,
  subscribe: optional(Schema.Literals(['public', 'signed-in'])),
  channels: Schema.Array(Schema.String),
  res: Resolution,
  totals: Schema.Struct({
    events: Schema.Finite,
    publishes: Schema.Finite,
    subscribes: Schema.Finite,
    errors: Schema.Finite,
  }),
  points: Schema.Array(RealtimePoint),
});
export type RealtimeStatsResponse = typeof RealtimeStatsResponse.Type;

/** One custom metric (`Metrics.count`/`value`) in one bucket: how many values, and their sum. */
export const CustomMetricPoint = Schema.Struct({
  ts: Schema.String,
  count: Schema.Finite,
  sum: Schema.Finite,
});
export type CustomMetricPoint = typeof CustomMetricPoint.Type;

/**
 * A custom metric over the range. `Metrics.count(name, n)` records `n` with
 * unit `count`, so `sum` is the total; for `Metrics.value`, `sum / count` is
 * the average.
 */
export const CustomMetricStats = Schema.Struct({
  name: Schema.String,
  unit: optional(Schema.String),
  count: Schema.Finite,
  sum: Schema.Finite,
  /** One per bucket in the range, zero-filled. */
  points: Schema.Array(CustomMetricPoint),
});
export type CustomMetricStats = typeof CustomMetricStats.Type;

/** A stage's custom metrics recorded in the range, by name. */
export const CustomMetricsResponse = Schema.Struct({
  app: Schema.String,
  stage: Schema.String,
  res: Resolution,
  metrics: Schema.Array(CustomMetricStats),
});
export type CustomMetricsResponse = typeof CustomMetricsResponse.Type;

/** One rate limit's checks in one bucket. */
export const LimitPoint = Schema.Struct({
  ts: Schema.String,
  allowed: Schema.Finite,
  denied: Schema.Finite,
});
export type LimitPoint = typeof LimitPoint.Type;

/** A rate limit's checks over the range, by its name in `RateLimits`. */
export const LimitStats = Schema.Struct({
  name: Schema.String,
  allowed: Schema.Finite,
  denied: Schema.Finite,
  /** One per bucket in the range, zero-filled. */
  points: Schema.Array(LimitPoint),
});
export type LimitStats = typeof LimitStats.Type;

/** A stage's rate limits that were checked in the range, most denied first. */
export const LimitsResponse = Schema.Struct({
  app: Schema.String,
  stage: Schema.String,
  res: Resolution,
  limits: Schema.Array(LimitStats),
});
export type LimitsResponse = typeof LimitsResponse.Type;

/** Per-tenant SES counts in one bucket (CloudWatch `Sum`s of `AWS/SES` by tenant). */
export const EmailPoint = Schema.Struct({
  ts: Schema.String,
  sends: Schema.Finite,
  deliveries: Schema.Finite,
  bounces: Schema.Finite,
  complaints: Schema.Finite,
});
export type EmailPoint = typeof EmailPoint.Type;

/**
 * Whether SES lets a stage send. `paused` comes with who paused it: `policy`
 * (the tenant's reputation policy, after bad bounce or complaint rates),
 * `manual` (someone changed it in SES), or `aws` (only AWS Support can lift
 * that one).
 */
export const EmailSending = Schema.Struct({
  status: Schema.Literals(['enabled', 'paused']),
  pausedBy: optional(Schema.Literals(['policy', 'manual', 'aws'])),
  /** SES's reason, when paused. */
  cause: optional(Schema.String),
  since: optional(Schema.String),
});
export type EmailSending = typeof EmailSending.Type;

/** A stage's email: its sender, whether it can send, today's usage and SES's counts over the range. */
export const EmailStatsResponse = Schema.Struct({
  app: Schema.String,
  stage: Schema.String,
  /** False when the live deployment declares no `email`; the rest is then empty. */
  enabled: Schema.Boolean,
  /** `"Todo" <todo@mail…>`. */
  from: optional(Schema.String),
  sending: optional(EmailSending),
  /** Recipients sent today (UTC) and the stage's daily limit. */
  today: optional(Schema.Struct({ sent: Schema.Finite, limit: Schema.Finite })),
  res: Resolution,
  totals: Schema.Struct({
    sends: Schema.Finite,
    deliveries: Schema.Finite,
    bounces: Schema.Finite,
    complaints: Schema.Finite,
  }),
  points: Schema.Array(EmailPoint),
});
export type EmailStatsResponse = typeof EmailStatsResponse.Type;

/** An address on a stage's suppression list: SES no longer sends to it from this stage. */
export const SuppressedAddress = Schema.Struct({
  address: Schema.String,
  reason: Schema.Literals(['bounce', 'complaint']),
  since: Schema.String,
});
export type SuppressedAddress = typeof SuppressedAddress.Type;

export const SuppressedResponse = Schema.Struct({
  items: Schema.Array(SuppressedAddress),
  next: optional(Schema.String),
});
export type SuppressedResponse = typeof SuppressedResponse.Type;

export const ErrorStatus = Schema.Literals(['open', 'resolved', 'ignored']);
export type ErrorStatus = typeof ErrorStatus.Type;

export const ErrorGroup = Schema.Struct({
  fingerprint: Schema.String,
  stage: Schema.String,
  name: Schema.String,
  message: Schema.String,
  source: Schema.String,
  count: Schema.Finite,
  firstSeen: Schema.String,
  lastSeen: Schema.String,
  status: ErrorStatus,
  sample: Schema.Struct({
    stack: optional(Schema.String),
    route: optional(Schema.String),
    job: optional(Schema.String),
    trace: optional(Schema.String),
    rev: optional(Schema.String),
  }),
});
export type ErrorGroup = typeof ErrorGroup.Type;

export const UpdateErrorRequest = Schema.Struct({ status: ErrorStatus });
export type UpdateErrorRequest = typeof UpdateErrorRequest.Type;

/** Log stream of a line: `web` or `worker`. */
export const LogStream = Schema.String;
export type LogStream = typeof LogStream.Type;

export const LogLine = Schema.Struct({
  ts: Schema.String,
  stream: LogStream,
  level: optional(Schema.String),
  message: Schema.String,
  trace: optional(Schema.String),
  event: optional(TelemetryEvent),
});
export type LogLine = typeof LogLine.Type;

export const LogsResponse = Schema.Struct({
  lines: Schema.Array(LogLine),
  nextToken: optional(Schema.String),
});
export type LogsResponse = typeof LogsResponse.Type;

export const TraceResponse = Schema.Struct({
  trace: Schema.String,
  events: Schema.Array(TelemetryEvent),
});
export type TraceResponse = typeof TraceResponse.Type;

/** Lines around one line of a stream, oldest first; `anchor` is that line's index. */
export const LogContextResponse = Schema.Struct({
  lines: Schema.Array(LogLine),
  anchor: Schema.Finite,
});
export type LogContextResponse = typeof LogContextResponse.Type;

/** How many lines of a range have a value of a field. */
export const FacetCount = Schema.Struct({ value: Schema.String, count: Schema.Finite });
export type FacetCount = typeof FacetCount.Type;

/** Lines per bucket by level, and counts of each field's commonest values, for the range and filters. */
export const LogStatsResponse = Schema.Struct({
  res: QueryResolution,
  timestamps: Schema.Array(Schema.String),
  levels: Schema.Struct({
    error: Schema.Array(Schema.Finite),
    warn: Schema.Array(Schema.Finite),
    info: Schema.Array(Schema.Finite),
    debug: Schema.Array(Schema.Finite),
    system: Schema.Array(Schema.Finite),
  }),
  total: Schema.Finite,
  facets: Schema.Struct({
    level: Schema.Array(FacetCount),
    stream: Schema.Array(FacetCount),
    route: Schema.Array(FacetCount),
    status: Schema.Array(FacetCount),
    rev: Schema.Array(FacetCount),
  }),
});
export type LogStatsResponse = typeof LogStatsResponse.Type;

/** A request or job that started a trace (its root line). */
export const TraceSummary = Schema.Struct({
  trace: Schema.String,
  /** When it started, ISO. */
  ts: Schema.String,
  kind: Schema.Literals(['req', 'job']),
  /** `GET /api/items/:id` or `queue refresh`. */
  name: Schema.String,
  /** The HTTP status of a request. */
  status: optional(Schema.Finite),
  /** A 5xx request or a failed job. */
  failed: Schema.Boolean,
  dur: Schema.Finite,
  /** Its spans were written (it failed, was slow, or its trace was sampled). */
  recorded: Schema.Boolean,
  /** Calls it made that weren't written. */
  calls: optional(Schema.Finite),
  rev: optional(Schema.String),
});
export type TraceSummary = typeof TraceSummary.Type;

export const TracesResponse = Schema.Struct({
  traces: Schema.Array(TraceSummary),
  /** More matched than `limit`; narrow the range or filters to see the rest. */
  truncated: Schema.Boolean,
});
export type TracesResponse = typeof TracesResponse.Type;

export const InsightsRequest = Schema.Struct({
  stage: optional(Schema.String),
  /**
   * A Logs Insights query (the Logs Insights language only). It runs on the
   * stage's own log groups; one that picks its own (`SOURCE`) is refused.
   */
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(10_000)),
  from: optional(Schema.String),
  to: optional(Schema.String),
  range: optional(Schema.String),
});
export type InsightsRequest = typeof InsightsRequest.Type;

export const InsightsResponse = Schema.Struct({
  /** Result fields in the order the query produced them (hidden `@ptr` left out). */
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Schema.NullOr(Schema.String))),
  recordsMatched: Schema.Finite,
  recordsScanned: Schema.Finite,
  bytesScanned: Schema.Finite,
});
export type InsightsResponse = typeof InsightsResponse.Type;

/** An error group's events per bucket, and the deployments they happened on (Logs Insights). */
export const ErrorOccurrencesResponse = Schema.Struct({
  res: QueryResolution,
  timestamps: Schema.Array(Schema.String),
  counts: Schema.Array(Schema.Finite),
  revs: Schema.Array(FacetCount),
});
export type ErrorOccurrencesResponse = typeof ErrorOccurrencesResponse.Type;

/** One line of a series answer: a group's values (key `all` when ungrouped), one per timestamp. */
export const SeriesLine = Schema.Struct({
  key: Schema.String,
  values: Schema.Array(Schema.NullOr(Schema.Finite)),
});
export type SeriesLine = typeof SeriesLine.Type;

export const SeriesResponse = Schema.Struct({
  res: QueryResolution,
  /** Bucket start times, ISO, oldest first. */
  timestamps: Schema.Array(Schema.String),
  /** `count`, `per_second`, `percent`, `ms`, or a custom metric's own unit. */
  unit: Schema.String,
  series: Schema.Array(SeriesLine),
  /** `stat: histogram`: per timestamp, the count in each latency bucket (`LATENCY_BUCKETS_MS`, then the overflow). */
  histogram: optional(Schema.Array(Schema.Array(Schema.Finite))),
  /** Why the answer differs from what was asked (coarser buckets past minute data's 3 days, groups cut to the top 10). */
  note: optional(Schema.String),
});
export type SeriesResponse = typeof SeriesResponse.Type;

/** A GET of the stage's health path, for a stage that served nothing lately or has no server. */
export const UptimeCheck = Schema.Struct({
  ts: Schema.String,
  ok: Schema.Boolean,
  source: Schema.Literal('check'),
  /** The HTTP status; 0 when nothing answered within 10 s. */
  status: Schema.Finite,
  ms: Schema.Finite,
});
export type UptimeCheck = typeof UptimeCheck.Type;

/** The stage's own requests in the 10 minutes before `ts`: down when at least 3, half of them 5xx. */
export const UptimeTraffic = Schema.Struct({
  ts: Schema.String,
  ok: Schema.Boolean,
  source: Schema.Literal('traffic'),
  req: Schema.Finite,
  s5xx: Schema.Finite,
});
export type UptimeTraffic = typeof UptimeTraffic.Type;

export const UptimePoint = Schema.Union([UptimeCheck, UptimeTraffic]);
export type UptimePoint = typeof UptimePoint.Type;

/** A non-preview stage's server: how it runs, and (prod) what each mode would cost. */
export const StageCompute = Schema.Struct({
  stage: Schema.String,
  /** `web.compute` of the live deployment. */
  setting: Schema.Literals(WEB_COMPUTE_SETTINGS),
  compute: WebComputeMode,
  estimate: optional(ComputeEstimate),
  streak: optional(ComputeStreakSchema),
});
export type StageCompute = typeof StageCompute.Type;

export const CostResponse = Schema.Struct({
  app: Schema.String,
  currency: Schema.Literal('USD'),
  days: Schema.Array(Schema.Struct({ date: Schema.String, usd: Schema.Finite })),
  monthToDateUsd: Schema.Finite,
  /** Servers of the app's non-preview stages (previews run request mode). */
  compute: optional(Schema.Array(StageCompute)),
});
export type CostResponse = typeof CostResponse.Type;

// ---------------------------------------------------------------------------
// Data, storage, secrets, job controls
// ---------------------------------------------------------------------------

export const SecretInfo = Schema.Struct({
  name: Schema.String,
  scope: Schema.Literals(['stage', 'shared']),
  stage: optional(Schema.String),
  updatedAt: optional(Schema.String),
});
export type SecretInfo = typeof SecretInfo.Type;

export const SecretsResponse = Schema.Struct({
  secrets: Schema.Array(SecretInfo),
  /** Names `plat.config.ts` declares on the live deployment. */
  declared: Schema.Array(Schema.String),
  missing: Schema.Array(Schema.String),
});
export type SecretsResponse = typeof SecretsResponse.Type;

export const PutSecretRequest = Schema.Struct({
  value: Schema.String.check(
    Schema.isNonEmpty({ message: 'value is required' }),
    Schema.isMaxLength(4096, { message: 'secret values are limited to 4 KB' }),
  ),
});
export type PutSecretRequest = typeof PutSecretRequest.Type;

/** `GET /v1/apps/:app/data/collections`. */
export const DataCollections = Schema.Struct({
  /**
   * Whether the stage has a table. False when `db` is off in plat.config.ts or
   * the stage was never deployed; a table kept after turning `db` off counts.
   */
  database: Schema.Boolean,
  /** Item counts come from a bounded scan sample, so large collections are undercounted. */
  collections: Schema.Array(Schema.Struct({ name: Schema.String, sampled: Schema.Finite })),
});
export type DataCollections = typeof DataCollections.Type;

export const DataPage = Schema.Struct({
  items: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  cursor: optional(Schema.String),
});
export type DataPage = typeof DataPage.Type;

export const StoredObjectInfo = Schema.Struct({
  key: Schema.String,
  size: Schema.Finite,
  lastModified: optional(Schema.String),
});
export type StoredObjectInfo = typeof StoredObjectInfo.Type;

/**
 * `GET /v1/apps/:app/storage`: the declared stores (and which of them the
 * edge serves) without `?store=`, a listing with it.
 */
export const StorageResponse = Schema.Union([
  Schema.Struct({ stores: Schema.Array(Schema.String), public: optional(Schema.Array(Schema.String)) }),
  Schema.Struct({ objects: Schema.Array(StoredObjectInfo), cursor: optional(Schema.String) }),
]);
export type StorageResponse = typeof StorageResponse.Type;

export const UrlResponse = Schema.Struct({ url: Schema.String });
export type UrlResponse = typeof UrlResponse.Type;

export const CronRunResponse = Schema.Struct({ started: Schema.String });
export type CronRunResponse = typeof CronRunResponse.Type;

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const AdminOverview = Schema.Struct({
  members: Schema.Array(Schema.Struct({ github: Schema.String, role: MemberRole })),
  limits: Schema.Struct({
    appsPerMember: Schema.Finite,
    stagesPerApp: Schema.Finite,
    emailsPerDay: Schema.Finite,
    edgeRequestsPerMinute: optional(Schema.Finite),
    edgeFloorAt: optional(Schema.Finite),
  }),
  apps: Schema.Finite,
  stages: Schema.Finite,
  previews: Schema.Finite,
  /** Apps with a stage whose uptime check is failing. */
  down: Schema.Array(Schema.String),
  cost: Schema.Struct({ total: Schema.NullOr(CostResponse), shared: Schema.NullOr(CostResponse) }),
});
export type AdminOverview = typeof AdminOverview.Type;

/** Requests the edge's web ACL handled in one bucket (CloudWatch `Sum`s). */
export const EdgeFloorPoint = Schema.Struct({
  ts: Schema.String,
  /** Blocked by the per-client floor. */
  blocked: Schema.Finite,
  /** Let through (every request the web ACL saw and allowed). */
  allowed: Schema.Finite,
});
export type EdgeFloorPoint = typeof EdgeFloorPoint.Type;

/** A request the floor blocked, from WAF's sample of the last three hours. */
export const EdgeFloorSample = Schema.Struct({
  at: Schema.String,
  host: Schema.String,
  client: Schema.String,
  country: optional(Schema.String),
  method: Schema.String,
  path: Schema.String,
});
export type EdgeFloorSample = typeof EdgeFloorSample.Type;

/** Whether the edge floor is on, since when, and why it turned on or off. */
export const EdgeFloorState = Schema.Struct({
  on: Schema.Boolean,
  /** Absent until it first turns on. */
  since: optional(Schema.String),
  why: optional(Schema.String),
});
export type EdgeFloorState = typeof EdgeFloorState.Type;

/**
 * The edge's per-client request floor across every app: on only while the
 * whole edge is busy (`limits.edgeFloorAt`), then `limits.edgeRequestsPerMinute`
 * per client and host. Counts cover the range whether or not it was on then.
 */
export const EdgeFloorResponse = Schema.Struct({
  /** False when the platform has no floor; the rest is then empty. */
  enabled: Schema.Boolean,
  state: EdgeFloorState,
  /** Requests per client per host per minute while it's on. */
  limit: optional(Schema.Finite),
  /** Requests per minute across the edge that turn it on. */
  threshold: optional(Schema.Finite),
  res: Resolution,
  totals: Schema.Struct({ blocked: Schema.Finite, allowed: Schema.Finite }),
  points: Schema.Array(EdgeFloorPoint),
  /** Newest first. WAF samples a share of requests, so counts here undercount. */
  samples: Schema.Array(EdgeFloorSample),
});
export type EdgeFloorResponse = typeof EdgeFloorResponse.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Body of every API error, whatever the status. */
export const ApiErrorBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});
export type ApiErrorBody = typeof ApiErrorBody.Type;
