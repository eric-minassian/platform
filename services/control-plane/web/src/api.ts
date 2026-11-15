/** Typed client for the control plane API. Types come from core (type-only imports). */
import type {
  AppRecord,
  AppSummary,
  CostResponse,
  DataPage,
  DeploymentRecord,
  ErrorGroup,
  JobStats,
  LogsResponse,
  MeResponse,
  MetricsResponse,
  QueueStats,
  RouteStats,
  SecretInfo,
  StageRecord,
  TraceResponse,
  UptimePoint,
} from '@ericminassian/platform-core';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'x-platform-csrf': '1',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    location.assign(`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiRequestError(
      res.status,
      body?.error?.code ?? 'http',
      body?.error?.message ?? res.statusText,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

export interface Scope {
  stage: string;
  range: string;
}

export interface SecretsResponse {
  secrets: SecretInfo[];
  declared: string[];
  missing: string[];
}

export interface AdminOverview {
  members: Array<{ github: string; role: string }>;
  limits: { appsPerMember: number; stagesPerApp: number };
  apps: number;
  stages: number;
  previews: number;
  down: string[];
  cost: { total: CostResponse | null; shared: CostResponse | null };
}

const a = (app: string) => `/v1/apps/${encodeURIComponent(app)}`;

export const api = {
  me: () => request<MeResponse>('/v1/me'),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  apps: () => request<AppSummary[]>('/v1/apps'),
  app: (app: string) => request<AppSummary>(a(app)),
  updateApp: (app: string, patch: Partial<Pick<AppRecord, 'description' | 'owners' | 'repo'>>) =>
    request<AppRecord>(a(app), json('PATCH', patch)),
  deleteApp: (app: string) => request<void>(a(app), json('DELETE')),
  stages: (app: string) => request<StageRecord[]>(`${a(app)}/stages`),
  destroyStage: (app: string, stage: string, confirm?: string) =>
    request<{ status: string }>(`${a(app)}/stages/${stage}${qs({ confirm })}`, json('DELETE')),
  rollback: (app: string, stage: string, deploymentId?: string) =>
    request<{ currentDeployment: string }>(
      `${a(app)}/stages/${stage}/rollback`,
      json('POST', { deploymentId }),
    ),
  deployments: (app: string, stage?: string) =>
    request<DeploymentRecord[]>(`${a(app)}/deployments${qs({ stage })}`),
  deployment: (id: string) => request<DeploymentRecord>(`/v1/deployments/${id}`),
  metrics: (app: string, s: Scope) => request<MetricsResponse>(`${a(app)}/metrics${qs({ ...s })}`),
  routes: (app: string, s: Scope) => request<RouteStats[]>(`${a(app)}/routes${qs({ ...s })}`),
  jobs: (app: string, s: Scope) =>
    request<{ jobs: JobStats[]; crons: Array<{ name: string; schedule: string }> }>(
      `${a(app)}/jobs${qs({ ...s })}`,
    ),
  queues: (app: string, stage: string) => request<QueueStats[]>(`${a(app)}/queues${qs({ stage })}`),
  runCron: (app: string, stage: string, name: string) =>
    request<{ started: string }>(`${a(app)}/crons/${name}/run${qs({ stage })}`, json('POST')),
  redrive: (app: string, stage: string, name: string) =>
    request<{ taskHandle?: string }>(`${a(app)}/queues/${name}/redrive${qs({ stage })}`, json('POST')),
  errors: (app: string, stage: string, status?: string) =>
    request<ErrorGroup[]>(`${a(app)}/errors${qs({ stage, status })}`),
  setErrorStatus: (app: string, stage: string, fp: string, status: ErrorGroup['status']) =>
    request<{ status: string }>(`${a(app)}/errors/${fp}${qs({ stage })}`, json('PATCH', { status })),
  uptime: (app: string, s: Scope) => request<UptimePoint[]>(`${a(app)}/uptime${qs({ ...s })}`),
  cost: (app: string, days = 35) => request<CostResponse>(`${a(app)}/cost${qs({ days })}`),
  logs: (app: string, p: Scope & { q?: string; stream?: string; next?: string }) =>
    request<LogsResponse>(`${a(app)}/logs${qs({ ...p })}`),
  tailUrl: (app: string, stage: string, q?: string) => `${a(app)}/logs/tail${qs({ stage, q })}`,
  trace: (app: string, stage: string, trace: string) =>
    request<TraceResponse>(`${a(app)}/traces/${trace}${qs({ stage })}`),
  collections: (app: string, stage: string) =>
    request<Array<{ name: string; sampled: number }>>(`${a(app)}/data/collections${qs({ stage })}`),
  items: (app: string, stage: string, collection: string, partition?: string, cursor?: string) =>
    request<DataPage>(`${a(app)}/data/items${qs({ stage, collection, partition, cursor })}`),
  stores: (app: string, stage: string) => request<{ stores: string[] }>(`${a(app)}/storage${qs({ stage })}`),
  objects: (app: string, stage: string, store: string, prefix?: string, cursor?: string) =>
    request<{ objects: Array<{ key: string; size: number; lastModified?: string }>; cursor?: string }>(
      `${a(app)}/storage${qs({ stage, store, prefix, cursor })}`,
    ),
  objectUrl: (app: string, stage: string, store: string, key: string) =>
    request<{ url: string }>(`${a(app)}/storage/url${qs({ stage, store, key })}`),
  secrets: (app: string, stage: string) => request<SecretsResponse>(`${a(app)}/secrets${qs({ stage })}`),
  putSecret: (app: string, stage: string, name: string, value: string, shared: boolean) =>
    request<void>(
      `${a(app)}/secrets/${name}${qs({ stage, scope: shared ? 'shared' : undefined })}`,
      json('PUT', { value }),
    ),
  deleteSecret: (app: string, stage: string, name: string, shared: boolean) =>
    request<void>(
      `${a(app)}/secrets/${name}${qs({ stage, scope: shared ? 'shared' : undefined })}`,
      json('DELETE'),
    ),
  adminOverview: () => request<AdminOverview>('/v1/admin/overview'),
};
