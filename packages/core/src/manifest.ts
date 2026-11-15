import { z } from 'zod';
import { validateCron } from './cron.ts';
import { APP_NAME_PATTERN, ENV_NAME_PATTERN, EVENT_TYPE_PATTERN, RESOURCE_KEY_PATTERN } from './naming.ts';

/**
 * The app's config file, at the app root. `plat` evaluates it and sends the
 * result to the platform as JSON; the control plane never runs app code.
 */
export const APP_CONFIG_FILE = 'plat.config.ts';

/**
 * What `plat.config.ts` declares: everything an app needs, in cloud-neutral
 * terms. This is the whole contract between an app repo and the platform;
 * apps contain no infrastructure code. Keep this schema small and stable.
 *
 * `ManifestSchema` validates the evaluated config (CLI and API); `AppConfig`
 * below is the same shape written for authors. `test/manifest-types.test.ts`
 * keeps the two in step.
 */
const resourceKey = z.string().regex(RESOURCE_KEY_PATTERN, 'must be 1-20 chars of a-z, 0-9, hyphens');
const eventType = z.string().regex(EVENT_TYPE_PATTERN);

const WebSchema = z
  .object({
    server: z.string().optional(),
    static: z.string().optional(),
    build: z.string().optional(),
    dev: z.object({ command: z.string(), port: z.number().int().min(1).max(65535).optional() }).optional(),
    spa: z.boolean().default(true),
    serverRoutes: z.array(z.string().startsWith('/')).default(['/api/']),
    timeoutSeconds: z.number().int().min(3).max(900).default(30),
    concurrency: z.number().int().min(1).max(128).default(64),
  })
  .refine((w) => w.server || w.static, { message: 'web needs a server, a static directory, or both' });

const WorkerSchema = z.object({
  entry: z.string().default('src/worker.ts'),
  timeoutSeconds: z.number().int().min(1).max(900).default(60),
  memoryMb: z.number().int().min(128).max(10240).default(512),
});

const QueueSchema = z.object({
  batchSize: z.number().int().min(1).max(10).default(10),
  visibilityTimeoutSeconds: z.number().int().min(0).max(43200).optional(),
  maxReceiveCount: z.number().int().min(1).max(1000).default(5),
  concurrency: z.number().int().min(2).max(1000).optional(),
});

const CronSchema = z.union([z.string(), z.object({ schedule: z.string(), timezone: z.string().optional() })]);

const AuthSchema = z.union([z.boolean(), z.object({ required: z.boolean().default(false) })]);

export const ManifestSchema = z
  .object({
    name: z
      .string()
      // Reserved names are enforced when an app is registered (API), not here:
      // the control plane itself is the app named `platform`.
      .regex(APP_NAME_PATTERN, 'must be 3-30 chars of a-z, 0-9, single hyphens'),
    description: z.string().max(200).optional(),
    web: WebSchema.optional(),
    worker: WorkerSchema.optional(),
    auth: AuthSchema.default(false),
    db: z.boolean().default(false),
    queues: z.record(resourceKey, QueueSchema).default({}),
    // The array form predates typed event payloads; deployments recorded
    // before then still store it.
    events: z.union([z.array(eventType), z.record(eventType, z.object({}))]).default([]),
    crons: z.record(resourceKey, CronSchema).default({}),
    storage: z.array(resourceKey).default([]),
    secrets: z.array(z.string().regex(ENV_NAME_PATTERN)).default([]),
    env: z.record(z.string().regex(ENV_NAME_PATTERN), z.string()).default({}),
  })
  .superRefine((m, ctx) => {
    for (const [key, cron] of Object.entries(m.crons)) {
      const err = validateCron(typeof cron === 'string' ? cron : cron.schedule);
      if (err) ctx.addIssue({ code: 'custom', path: ['crons', key], message: err });
    }
  });

/** The evaluated config as JSON: what the CLI sends and deployments store. */
export type ManifestInput = z.input<typeof ManifestSchema>;
export type Manifest = z.output<typeof ManifestSchema>;

// ---------------------------------------------------------------------------
// Authoring types. Arrays are readonly so `defineApp` can keep literal names.

/** Type-only marker for a queue's message body or an event's detail. Never set at runtime. */
declare const payloadType: unique symbol;

// A type literal, not an interface, so it fits the schema's `Record<string, never>` event options.
type Payload<T> = { readonly [payloadType]?: T };

/** The message or detail type declared with `queue<T>()` / `event<T>()`; `unknown` if none. */
export type PayloadOf<D> = D extends Payload<infer T> ? (unknown extends T ? unknown : T) : unknown;

export interface WebConfig {
  /** Entry module whose default export is a fetch handler (`{ fetch }`, a function, or a Hono app). */
  server?: string;
  /** Directory of built static assets, served from the edge. */
  static?: string;
  /** Shell command that builds `static` (run by `plat build`). */
  build?: string;
  /**
   * Dev server for the frontend, proxied by `plat dev` (e.g. Vite). The command
   * listens on the port `plat dev` passes in `PLATFORM_DEV_WEB_PORT` (and `PORT`):
   * `port` when it is free, otherwise any free port.
   */
  dev?: { command: string; port?: number };
  /** Serve `index.html` for unknown non-file paths (client-side routing). Default `true`. */
  spa?: boolean;
  /** When both `server` and `static` exist, path prefixes handled by the server. Default `['/api/']`. */
  serverRoutes?: readonly string[];
  /** 3-900. Default 30. */
  timeoutSeconds?: number;
  /** Max concurrent requests per Web Function environment, 1-128. Default 64. */
  concurrency?: number;
}

export interface WorkerConfig {
  /** Module whose default export is `defineWorker(...)`. Default `src/worker.ts`. */
  entry?: string;
  /** 1-900. Default 60. */
  timeoutSeconds?: number;
  /** 128-10240. Default 512. */
  memoryMb?: number;
}

/** Declare one with `queue<Body>({ ... })` to type what is sent and received. */
export interface QueueConfig<Body = unknown> extends Payload<Body> {
  /** Messages per worker invocation, 1-10. Default 10. */
  batchSize?: number;
  /** Defaults to 6x the worker timeout, as AWS recommends for Lambda consumers. */
  visibilityTimeoutSeconds?: number;
  /** Deliveries before a message moves to the dead-letter queue, 1-1000. Default 5. */
  maxReceiveCount?: number;
  /** Max concurrent worker invocations draining this queue, 2-1000. */
  concurrency?: number;
}

/** Declare one with `event<Detail>()` to type what is published and handled. */
export type EventConfig<Detail = unknown> = Payload<Detail>;

/** 5-field cron in UTC (`0 3 * * *`) or `rate(5 minutes)`. */
export type CronConfig = string | { schedule: string; timezone?: string };

export interface AppConfig {
  /** 3-30 chars of a-z, 0-9 and single hyphens; also the app's host name. */
  name: string;
  description?: string;
  web?: WebConfig;
  /** Present automatically when any queue, event or cron exists. */
  worker?: WorkerConfig;
  /** Sign-in with the shared user pool. `{ required: true }` guards every non-platform route. */
  auth?: boolean | { required?: boolean };
  /** One document database per stage; collections are declared in code. */
  db?: boolean;
  /** Keys are 1-20 chars of a-z, 0-9 and hyphens. Each needs a handler in the worker. */
  queues?: { readonly [name: string]: QueueConfig };
  /** Event types the worker subscribes to, e.g. `order.created`. Each needs a handler in the worker. */
  events?: readonly string[] | { readonly [type: string]: EventConfig };
  /** Scheduled jobs. Each needs a handler in the worker. */
  crons?: { readonly [name: string]: CronConfig };
  /** Named file stores. */
  storage?: readonly string[];
  /** Secret names like `STRIPE_KEY`; values are set with `plat secrets set`. */
  secrets?: readonly string[];
  /** Plain, non-secret configuration exposed as environment variables. */
  env?: { readonly [name: string]: string };
}

/**
 * Maps every key `T` has but `Shape` doesn't to `never`, recursively, so a
 * misspelled field is a type error. `defineApp` needs this because a generic
 * parameter (which keeps the literal names) skips excess-property checks.
 */
type Exact<T, Shape> = Shape extends readonly (infer S)[]
  ? T extends readonly (infer E)[]
    ? readonly Exact<E, S>[]
    : Shape
  : Shape extends object
    ? T extends object
      ? { [K in keyof T]: K extends keyof Shape ? Exact<T[K], Shape[K]> : never }
      : Shape
    : Shape;

/**
 * The default export of `plat.config.ts`. Returns the config unchanged with
 * its literal names, which `Register` hands to the SDK so queue, event, cron,
 * store and secret names (and payload types) are checked in app code.
 */
export function defineApp<const T extends AppConfig>(config: T & Exact<T, AppConfig>): T {
  return config;
}

/** A queue whose messages are `Body`: `queues: { emails: queue<EmailJob>({ batchSize: 5 }) }`. */
export function queue<Body>(options: QueueConfig = {}): QueueConfig<Body> {
  return options as QueueConfig<Body>;
}

/** An event subscription whose detail is `Detail`: `events: { 'todo.created': event<TodoCreated>() }`. */
export function event<Detail>(): EventConfig<Detail> {
  return {};
}

// ---------------------------------------------------------------------------

/** Manifest with defaults applied and derived fields normalized. */
export interface ResolvedManifest {
  name: string;
  description?: string;
  web?: z.output<typeof WebSchema>;
  /** Present when any queue, event subscription or cron exists. */
  worker?: z.output<typeof WorkerSchema>;
  auth: { enabled: boolean; required: boolean };
  db: boolean;
  queues: Record<string, z.output<typeof QueueSchema> & { visibilityTimeoutSeconds: number }>;
  events: string[];
  crons: Record<string, { schedule: string; timezone?: string }>;
  storage: string[];
  secrets: string[];
  env: Record<string, string>;
}

export class ManifestError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid ${APP_CONFIG_FILE}:\n  - ${issues.join('\n  - ')}`);
    this.issues = issues;
  }
}

export function parseManifest(input: unknown): ResolvedManifest {
  const parsed = ManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ManifestError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return resolveManifest(parsed.data);
}

export function resolveManifest(m: Manifest): ResolvedManifest {
  const events = Array.isArray(m.events) ? m.events : Object.keys(m.events);
  const needsWorker =
    Object.keys(m.queues).length > 0 || events.length > 0 || Object.keys(m.crons).length > 0;
  const worker = m.worker ?? (needsWorker ? WorkerSchema.parse({}) : undefined);
  const auth =
    typeof m.auth === 'boolean'
      ? { enabled: m.auth, required: false }
      : { enabled: true, required: m.auth.required };
  const queues: ResolvedManifest['queues'] = {};
  for (const [key, q] of Object.entries(m.queues)) {
    queues[key] = {
      ...q,
      visibilityTimeoutSeconds: q.visibilityTimeoutSeconds ?? (worker?.timeoutSeconds ?? 60) * 6,
    };
  }
  const crons: ResolvedManifest['crons'] = {};
  for (const [key, c] of Object.entries(m.crons)) crons[key] = typeof c === 'string' ? { schedule: c } : c;
  return {
    name: m.name,
    ...(m.description ? { description: m.description } : {}),
    ...(m.web ? { web: m.web } : {}),
    ...(worker ? { worker } : {}),
    auth,
    db: m.db,
    queues,
    events: [...new Set(events)],
    crons,
    storage: [...new Set(m.storage)],
    secrets: [...new Set(m.secrets)],
    env: m.env,
  };
}
