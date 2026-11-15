/**
 * Control plane API types, shared by the API server, the console and the CLI.
 * All routes live under `/v1`. Auth is one of:
 *  - `Authorization: Bearer <platform token>` (CLI, from `plat login`)
 *  - `Authorization: Bearer <GitHub Actions OIDC token>` (CI deploys only)
 *  - session cookie (console, after "Sign in with GitHub")
 */
import type { MemberRole } from './config.ts';
import type { ManifestInput, ResolvedManifest } from './manifest.ts';
import type { Resolution, TelemetryEvent } from './telemetry.ts';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface AppRecord {
  name: string;
  /** GitHub `owner/name` allowed to deploy this app from CI. */
  repo: string;
  description?: string;
  /** GitHub usernames who can manage the app (admins can manage everything). */
  owners: string[];
  createdBy: string;
  createdAt: string;
}

export type StageStatus = 'active' | 'deploying' | 'failed' | 'destroying' | 'destroyed';

export interface StageRecord {
  app: string;
  stage: string;
  host: string;
  url: string;
  status: StageStatus;
  preview: boolean;
  currentDeployment?: string;
  previousDeployment?: string;
  /** Web Function revision ids, for instant rollback. */
  currentRevision?: string;
  previousRevision?: string;
  createdAt: string;
  updatedAt: string;
}

export type DeploymentStatus =
  | 'awaiting_upload'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rolled_back';

export interface DeploymentEventEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
  /** Resource the step acted on, e.g. `table foo--prod`. */
  resource?: string;
}

export interface DeploymentRecord {
  id: string;
  app: string;
  stage: string;
  status: DeploymentStatus;
  /** GitHub username, or `ci:<repo>` for OIDC deploys. */
  actor: string;
  commit?: string;
  ref?: string;
  message?: string;
  manifest?: ResolvedManifest;
  url?: string;
  error?: string;
  events: DeploymentEventEntry[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// Requests / responses
// ---------------------------------------------------------------------------

export interface MeResponse {
  github: string;
  role: MemberRole;
}

export interface CliLoginRequest {
  /** A GitHub token for the user (e.g. `gh auth token`); used once to identify them. */
  githubToken: string;
}

export interface CliLoginResponse {
  token: string;
  github: string;
  role: MemberRole;
  expiresAt: string;
}

export interface CreateAppRequest {
  name: string;
  repo: string;
  description?: string;
}

export type ArtifactFile = 'manifest.json' | 'server.zip' | 'worker.zip' | 'static.zip';

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

export interface CreateDeploymentRequest {
  stage: string;
  manifest: ManifestInput;
  /** Which artifacts the CLI will upload (manifest.json is always uploaded). */
  files: ArtifactFile[];
  commit?: string;
  ref?: string;
  message?: string;
}

export interface CreateDeploymentResponse {
  deployment: DeploymentRecord;
  uploads: Partial<Record<ArtifactFile, PresignedPost>>;
}

export interface AppSummary {
  app: AppRecord;
  stages: StageRecord[];
  /** Prod health over the last hour (null when there is no prod stage). */
  health: {
    up: boolean | null;
    reqPerMin: number;
    errorRate: number;
    p95: number | null;
  } | null;
  costMonthToDateUsd?: number;
  lastDeployment?: DeploymentRecord;
}

export interface MetricsPoint {
  ts: string;
  req: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  cold: number;
}

export interface MetricsResponse {
  app: string;
  stage: string;
  res: Resolution;
  points: MetricsPoint[];
}

export interface RouteStats {
  route: string;
  method: string;
  req: number;
  s5xx: number;
  s4xx: number;
  p50: number | null;
  p95: number | null;
}

export interface JobStats {
  kind: 'queue' | 'event' | 'cron' | 'invoke';
  name: string;
  ok: number;
  error: number;
  p95: number | null;
  lastRun?: string;
}

export interface QueueStats {
  name: string;
  visible: number;
  inFlight: number;
  deadLetter: number;
  oldestAgeSeconds: number | null;
}

export interface ErrorGroup {
  fingerprint: string;
  stage: string;
  name: string;
  message: string;
  source: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  status: 'open' | 'resolved' | 'ignored';
  sample: { stack?: string; route?: string; job?: string; trace?: string; rev?: string };
}

export interface LogLine {
  ts: string;
  stream: 'web' | 'worker';
  level?: string;
  message: string;
  trace?: string;
  event?: TelemetryEvent;
}

export interface LogsResponse {
  lines: LogLine[];
  nextToken?: string;
}

export interface TraceResponse {
  trace: string;
  events: TelemetryEvent[];
}

export interface UptimePoint {
  ts: string;
  ok: boolean;
  status: number;
  ms: number;
}

export interface CostResponse {
  app: string;
  currency: 'USD';
  days: Array<{ date: string; usd: number }>;
  monthToDateUsd: number;
}

export interface SecretInfo {
  name: string;
  scope: 'stage' | 'shared';
  stage?: string;
  updatedAt?: string;
}

export interface DataPage {
  items: Record<string, unknown>[];
  cursor?: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
