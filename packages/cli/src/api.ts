/**
 * Typed client for the control plane API (`/v1`). Route shapes follow the
 * design in docs/DESIGN.md; list endpoints return `{ <plural>: [...] }`.
 *
 * Auth, in order: an explicit token, GitHub Actions OIDC (CI), the token
 * stored by `plat login`.
 */
import {
  type AppRecord,
  type AppSummary,
  type CliLoginRequest,
  type CliLoginResponse,
  type CreateAppRequest,
  type CreateDeploymentRequest,
  type CreateDeploymentResponse,
  type DataCollections,
  type DataPage,
  type DeploymentRecord,
  type EmailSending,
  type EmailStatsResponse,
  type ErrorGroup,
  type JobStats,
  type LimitsResponse,
  type LogLine,
  type LogsResponse,
  type MeResponse,
  type MetricsResponse,
  PLATFORM_DEFAULTS,
  type QueueStats,
  type RealtimeStatsResponse,
  type Resolution,
  type RollbackRequest,
  type RollbackResponse,
  type RouteStats,
  type SecretInfo,
  type StageRecord,
  type StoredObjectInfo,
  type SuppressedResponse,
  type TraceResponse,
} from './api-types.ts';
import { isExpired, loadCredentials } from './credentials.ts';
import { canUseOidc, fetchOidcToken } from './github.ts';
import { CliError, EXIT } from './util/output.ts';

export function apiBaseUrl(env = process.env): string {
  return (env.PLATFORM_API_URL || PLATFORM_DEFAULTS.apiUrl).replace(/\/$/, '');
}

export class ApiError extends CliError {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message, {
      hint: hintFor(status),
      exitCode: status === 401 || status === 403 ? EXIT.auth : status === 404 ? EXIT.notFound : EXIT.error,
    });
    this.status = status;
    this.code = code;
  }
}

function hintFor(status: number): string | undefined {
  if (status === 401) return 'run `plat login` (or check the CI workflow has `id-token: write`)';
  if (status === 403) return 'you are not allowed to do this; ask a platform admin';
  if (status === 404) return 'check the app/stage name with `plat apps list` / `plat stages`';
  return undefined;
}

export type AuthMode = 'auto' | 'token' | 'oidc' | 'none';

export interface ApiClientOptions {
  baseUrl?: string;
  token?: string;
  auth?: AuthMode;
  fetch?: typeof fetch;
}

type Query = Record<string, string | number | boolean | undefined>;

export class ApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authMode: AuthMode;
  private token?: string;

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? apiBaseUrl()).replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.authMode = opts.auth ?? 'auto';
    this.token = opts.token;
  }

  /** The bearer token this client will send (resolved lazily). */
  async authorization(): Promise<string | undefined> {
    if (this.token) return this.token;
    if (this.authMode === 'none') return undefined;
    if (this.authMode !== 'token' && canUseOidc()) {
      this.token = await fetchOidcToken(PLATFORM_DEFAULTS.oidcAudience);
      return this.token;
    }
    if (this.authMode === 'oidc') {
      throw new CliError('GitHub Actions OIDC is not available here', { exitCode: EXIT.auth });
    }
    const creds = loadCredentials();
    if (!creds) throw new CliError('not logged in', { hint: 'run `plat login`', exitCode: EXIT.auth });
    if (isExpired(creds))
      throw new CliError('your platform login has expired', {
        hint: 'run `plat login`',
        exitCode: EXIT.auth,
      });
    if (creds.apiUrl.replace(/\/$/, '') !== this.baseUrl) {
      throw new CliError(`stored login is for ${creds.apiUrl}, not ${this.baseUrl}`, {
        hint: 'run `plat login` again',
        exitCode: EXIT.auth,
      });
    }
    this.token = creds.token;
    return this.token;
  }

  url(path: string, query?: Query): string {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {}))
      if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    return u.toString();
  }

  async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const auth = await this.authorization();
    if (auth) headers.authorization = `Bearer ${auth}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, opts.query), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (err) {
      throw new CliError(`can't reach the platform API at ${this.baseUrl}: ${(err as Error).message}`, {
        hint: 'set PLATFORM_API_URL if the API lives elsewhere',
      });
    }
    const text = await res.text();
    const body = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const e = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new ApiError(
        res.status,
        e?.code ?? `http_${res.status}`,
        e?.message ?? `${method} ${path} failed (HTTP ${res.status})`,
      );
    }
    return body as T;
  }

  /** Server-sent events stream; yields parsed `data:` payloads. */
  async *stream<T>(path: string, query?: Query, signal?: AbortSignal): AsyncGenerator<T> {
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    const auth = await this.authorization();
    if (auth) headers.authorization = `Bearer ${auth}`;
    const res = await this.fetchImpl(this.url(path, query), { headers, signal });
    if (!res.ok || !res.body)
      throw new ApiError(res.status, `http_${res.status}`, `stream ${path} failed (HTTP ${res.status})`);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data) yield safeJson(data) as T;
        idx = buf.indexOf('\n\n');
      }
    }
  }

  // ------------------------------------------------------------- auth
  login(req: CliLoginRequest) {
    return this.request<CliLoginResponse>('POST', '/v1/auth/cli', { body: req });
  }
  me() {
    return this.request<MeResponse>('GET', '/v1/me');
  }

  // ------------------------------------------------------------- apps
  async listApps(): Promise<AppSummary[]> {
    return list(await this.request('GET', '/v1/apps'), 'apps');
  }
  getApp(app: string) {
    return this.request<AppSummary>('GET', `/v1/apps/${enc(app)}`);
  }
  createApp(req: CreateAppRequest) {
    return this.request<AppRecord>('POST', '/v1/apps', { body: req });
  }
  /** Unregister an app. The API refuses while any stage is still live. */
  deleteApp(app: string) {
    return this.request<unknown>('DELETE', `/v1/apps/${enc(app)}`);
  }

  // ------------------------------------------------------------- stages & deployments
  async listStages(app: string): Promise<StageRecord[]> {
    return list(await this.request('GET', `/v1/apps/${enc(app)}/stages`), 'stages');
  }
  destroyStage(app: string, stage: string) {
    // The API requires an explicit confirmation to destroy prod.
    return this.request<unknown>('DELETE', `/v1/apps/${enc(app)}/stages/${enc(stage)}`, {
      query: stage === 'prod' ? { confirm: app } : {},
    });
  }
  rollback(app: string, stage: string, toDeployment?: string) {
    const body: RollbackRequest = toDeployment ? { deploymentId: toDeployment } : {};
    return this.request<RollbackResponse>('POST', `/v1/apps/${enc(app)}/stages/${enc(stage)}/rollback`, {
      body,
    });
  }
  createDeployment(app: string, req: CreateDeploymentRequest) {
    return this.request<CreateDeploymentResponse>('POST', `/v1/apps/${enc(app)}/deployments`, { body: req });
  }
  startDeployment(id: string) {
    return this.request<DeploymentRecord>('POST', `/v1/deployments/${enc(id)}/start`, { body: {} });
  }
  getDeployment(id: string) {
    return this.request<DeploymentRecord>('GET', `/v1/deployments/${enc(id)}`);
  }
  async listDeployments(app: string, stage?: string): Promise<DeploymentRecord[]> {
    return list(
      await this.request('GET', `/v1/apps/${enc(app)}/deployments`, { query: { stage } }),
      'deployments',
    );
  }

  // ------------------------------------------------------------- observability
  metrics(app: string, q: { stage: string; from: number; to: number; res: Resolution }) {
    return this.request<MetricsResponse>('GET', `/v1/apps/${enc(app)}/metrics`, { query: q });
  }
  async routes(app: string, q: { stage: string; from: number; to: number }): Promise<RouteStats[]> {
    return list(await this.request('GET', `/v1/apps/${enc(app)}/routes`, { query: q }), 'routes');
  }
  async jobs(
    app: string,
    q: { stage: string; from: number; to: number },
  ): Promise<{ jobs: JobStats[]; queues: QueueStats[] }> {
    const [body, queues] = await Promise.all([
      this.request<{ jobs?: JobStats[] }>('GET', `/v1/apps/${enc(app)}/jobs`, { query: q }),
      this.request<QueueStats[]>('GET', `/v1/apps/${enc(app)}/queues`, { query: { stage: q.stage } }),
    ]);
    return { jobs: body?.jobs ?? [], queues: Array.isArray(queues) ? queues : [] };
  }
  realtime(app: string, q: { stage: string; from: number; to: number; res: Resolution }) {
    return this.request<RealtimeStatsResponse>('GET', `/v1/apps/${enc(app)}/realtime`, { query: q });
  }
  limits(app: string, q: { stage: string; from: number; to: number }) {
    return this.request<LimitsResponse>('GET', `/v1/apps/${enc(app)}/limits`, { query: q });
  }
  async errors(app: string, q: { stage: string }): Promise<ErrorGroup[]> {
    return list(await this.request('GET', `/v1/apps/${enc(app)}/errors`, { query: q }), 'errors');
  }
  logs(
    app: string,
    q: { stage: string; from: number; to?: number; filter?: string; nextToken?: string; limit?: number },
  ) {
    const { filter, nextToken, ...rest } = q;
    return this.request<LogsResponse>('GET', `/v1/apps/${enc(app)}/logs`, {
      query: { ...rest, ...(filter ? { q: filter } : {}), ...(nextToken ? { next: nextToken } : {}) },
    });
  }
  tailLogs(app: string, q: { stage: string; filter?: string }, signal?: AbortSignal) {
    return this.stream<LogLine>(
      `/v1/apps/${enc(app)}/logs/tail`,
      { stage: q.stage, ...(q.filter ? { q: q.filter } : {}) },
      signal,
    );
  }
  trace(app: string, trace: string, q: { stage: string }) {
    return this.request<TraceResponse>('GET', `/v1/apps/${enc(app)}/traces/${enc(trace)}`, { query: q });
  }

  // ------------------------------------------------------------- data
  collections(app: string, q: { stage: string }) {
    return this.request<DataCollections>('GET', `/v1/apps/${enc(app)}/data/collections`, { query: q });
  }
  items(
    app: string,
    q: { stage: string; collection: string; partition?: string; cursor?: string; limit?: number },
  ) {
    return this.request<DataPage>('GET', `/v1/apps/${enc(app)}/data/items`, { query: q });
  }
  async files(app: string, q: { stage: string; store: string; prefix?: string; cursor?: string }) {
    return this.request<{ objects: StoredObjectInfo[]; cursor?: string }>(
      'GET',
      `/v1/apps/${enc(app)}/storage`,
      { query: q },
    );
  }

  // ------------------------------------------------------------- secrets & jobs
  async listSecrets(app: string, q: { stage: string }): Promise<SecretInfo[]> {
    return list(await this.request('GET', `/v1/apps/${enc(app)}/secrets`, { query: q }), 'secrets');
  }
  setSecret(app: string, name: string, body: { value: string; stage?: string; shared?: boolean }) {
    return this.request<SecretInfo>('PUT', `/v1/apps/${enc(app)}/secrets/${enc(name)}`, {
      body: { value: body.value },
      query: secretScope(body),
    });
  }
  deleteSecret(app: string, name: string, q: { stage?: string; shared?: boolean }) {
    return this.request<unknown>('DELETE', `/v1/apps/${enc(app)}/secrets/${enc(name)}`, {
      query: secretScope(q),
    });
  }
  runCron(app: string, name: string, stage: string) {
    return this.request<unknown>('POST', `/v1/apps/${enc(app)}/crons/${enc(name)}/run`, {
      body: {},
      query: { stage },
    });
  }

  // ------------------------------------------------------------- email
  email(app: string, q: { stage: string; from: number; to: number; res: Resolution }) {
    return this.request<EmailStatsResponse>('GET', `/v1/apps/${enc(app)}/email`, { query: q });
  }
  suppressed(app: string, q: { stage: string; next?: string }) {
    return this.request<SuppressedResponse>('GET', `/v1/apps/${enc(app)}/email/suppressed`, { query: q });
  }
  unsuppress(app: string, address: string, q: { stage: string }) {
    return this.request<unknown>('DELETE', `/v1/apps/${enc(app)}/email/suppressed/${enc(address)}`, {
      query: q,
    });
  }
  resumeEmail(app: string, q: { stage: string }) {
    return this.request<EmailSending>('POST', `/v1/apps/${enc(app)}/email/resume`, { query: q });
  }
}

const enc = encodeURIComponent;

/** The API scopes secrets with `?scope=shared` (app-wide) or `?stage=`. */
function secretScope(o: { stage?: string; shared?: boolean }): Record<string, string> {
  return o.shared ? { scope: 'shared' } : o.stage ? { stage: o.stage } : {};
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Accept `[...]` or `{ key: [...] }` / `{ items: [...] }`. */
function list<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  const obj = (body ?? {}) as Record<string, unknown>;
  const v = obj[key] ?? obj.items;
  return Array.isArray(v) ? (v as T[]) : [];
}
