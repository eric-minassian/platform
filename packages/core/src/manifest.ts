import { Effect, Schema } from 'effect';
import { validateCron } from './cron.ts';
import { EMAIL_DEFAULT_DAILY_LIMIT, EMAIL_NAME_MESSAGE, EMAIL_NAME_PATTERN } from './email.ts';
import { APP_NAME_PATTERN, ENV_NAME_PATTERN, EVENT_TYPE_PATTERN, RESOURCE_KEY_PATTERN } from './naming.ts';
import { CHANNEL_DECLARATION_PATTERN, CHANNEL_MESSAGE, realtimeIssues } from './realtime.ts';

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
const RESOURCE_KEY_MESSAGE = 'must be 1-20 chars of a-z, 0-9, hyphens';
const resourceKey = Schema.String.check(
  Schema.isPattern(RESOURCE_KEY_PATTERN, { message: RESOURCE_KEY_MESSAGE }),
);
const eventType = Schema.String.check(Schema.isPattern(EVENT_TYPE_PATTERN));
const envName = Schema.String.check(Schema.isPattern(ENV_NAME_PATTERN));

/**
 * A record whose keys must match `pattern`. `Schema.Record` drops keys that fail
 * its key schema, which would make a misnamed queue silently disappear, so
 * keys are checked here and reported at their path instead.
 */
const recordOf = <V extends Schema.Top>(pattern: RegExp, value: V, message = `must match ${pattern}`) =>
  Schema.Record(Schema.String, value).check(
    Schema.makeFilter((record) =>
      Object.keys(record)
        .filter((key) => !pattern.test(key))
        .map((key) => ({ path: [key], issue: message })),
    ),
  );
const intBetween = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));
/** Absent (or `undefined`) decodes to `value`. */
const orElse =
  <S extends Schema.Top>(value: S['Encoded']) =>
  (schema: S) =>
    schema.pipe(Schema.withDecodingDefault(Effect.succeed(value)));

const WebSchema = Schema.Struct({
  server: Schema.optional(Schema.String),
  static: Schema.optional(Schema.String),
  build: Schema.optional(Schema.String),
  dev: Schema.optional(
    Schema.Struct({ command: Schema.String, port: Schema.optional(intBetween(1, 65535)) }),
  ),
  spa: Schema.Boolean.pipe(orElse(true)),
  serverRoutes: Schema.Array(Schema.String.check(Schema.isStartingWith('/'))).pipe(orElse(['/api/'])),
  timeoutSeconds: intBetween(3, 900).pipe(orElse(30)),
  concurrency: intBetween(1, 128).pipe(orElse(64)),
}).check(
  Schema.makeFilter((w) =>
    w.server || w.static ? undefined : 'web needs a server, a static directory, or both',
  ),
);

const WorkerSchema = Schema.Struct({
  entry: Schema.String.pipe(orElse('src/worker.ts')),
  timeoutSeconds: intBetween(1, 900).pipe(orElse(60)),
  memoryMb: intBetween(128, 10240).pipe(orElse(512)),
});

const QueueSchema = Schema.Struct({
  batchSize: intBetween(1, 10).pipe(orElse(10)),
  visibilityTimeoutSeconds: Schema.optional(intBetween(0, 43200)),
  maxReceiveCount: intBetween(1, 1000).pipe(orElse(5)),
  concurrency: Schema.optional(intBetween(2, 1000)),
});

const CronSchema = Schema.Union([
  Schema.String,
  Schema.Struct({ schedule: Schema.String, timezone: Schema.optional(Schema.String) }),
]).check(
  Schema.makeFilter((cron) => validateCron(typeof cron === 'string' ? cron : cron.schedule) ?? undefined),
);

const AuthSchema = Schema.Union([
  Schema.Boolean,
  Schema.Struct({ required: Schema.Boolean.pipe(orElse(false)) }),
]);

const StoreSchema = Schema.Struct({
  public: Schema.Boolean.pipe(orElse(false)),
  expireAfterDays: Schema.optional(intBetween(1, 3650)),
});

const RealtimeSubscribeSchema = Schema.Literals(['public', 'signed-in']);

const EmailSchema = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    name: Schema.optional(
      Schema.String.check(Schema.isPattern(EMAIL_NAME_PATTERN, { message: EMAIL_NAME_MESSAGE })),
    ),
    // The platform's ceiling (`limits.emailsPerDay`) is checked when a deployment is created.
    dailyLimit: Schema.optional(intBetween(1, 1_000_000)),
  }),
]);

const RealtimeSchema = Schema.Struct({
  subscribe: RealtimeSubscribeSchema.pipe(orElse('public')),
  channels: recordOf(CHANNEL_DECLARATION_PATTERN, Schema.Struct({}), CHANNEL_MESSAGE),
});

export const ManifestSchema = Schema.Struct({
  // Reserved names are enforced when an app is registered (API), not here:
  // the control plane itself is the app named `platform`.
  name: Schema.String.check(
    Schema.isPattern(APP_NAME_PATTERN, { message: 'must be 3-30 chars of a-z, 0-9, single hyphens' }),
  ),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  web: Schema.optional(WebSchema),
  worker: Schema.optional(WorkerSchema),
  auth: AuthSchema.pipe(orElse(false)),
  db: Schema.Boolean.pipe(orElse(false)),
  queues: recordOf(RESOURCE_KEY_PATTERN, QueueSchema, RESOURCE_KEY_MESSAGE).pipe(orElse({})),
  // The array form predates typed event payloads; deployments recorded
  // before then still store it.
  events: Schema.Union([Schema.Array(eventType), recordOf(EVENT_TYPE_PATTERN, Schema.Struct({}))]).pipe(
    orElse([]),
  ),
  crons: recordOf(RESOURCE_KEY_PATTERN, CronSchema, RESOURCE_KEY_MESSAGE).pipe(orElse({})),
  // The array form (every store private, kept forever) is still accepted.
  storage: Schema.Union([
    Schema.Array(resourceKey),
    recordOf(RESOURCE_KEY_PATTERN, StoreSchema, RESOURCE_KEY_MESSAGE),
  ]).pipe(orElse([])),
  secrets: Schema.Array(envName).pipe(orElse([])),
  env: recordOf(ENV_NAME_PATTERN, Schema.String).pipe(orElse({})),
  realtime: Schema.optional(RealtimeSchema),
  email: EmailSchema.pipe(orElse(false)),
}).check(
  Schema.makeFilter((m) => {
    if (!m.realtime) return undefined;
    const issues = realtimeIssues({
      subscribe: m.realtime.subscribe,
      channels: Object.keys(m.realtime.channels),
      auth: m.auth !== false,
      server: Boolean(m.web?.server),
    });
    return issues.map((i) => ({ path: ['realtime', ...i.path], issue: i.message }));
  }),
);

/** The evaluated config as JSON: what the CLI sends and deployments store. */
export type ManifestInput = typeof ManifestSchema.Encoded;
export type Manifest = typeof ManifestSchema.Type;

// ---------------------------------------------------------------------------
// Authoring types. Arrays are readonly so `defineApp` can keep literal names.

/** Type-only marker for a queue's message body or an event's detail. Never set at runtime. */
declare const payloadType: unique symbol;

// A type literal, not an interface, so it fits the schema's `Record<string, never>` event options.
type Payload<T> = { readonly [payloadType]?: T };

/** The message or detail type declared with `queue<T>()` / `event<T>()`; `unknown` if none. */
export type PayloadOf<D> = D extends Payload<infer T> ? (unknown extends T ? unknown : T) : unknown;

export interface WebConfig {
  /** Entry module whose default export is `toFetchHandler(...)` from `@ericminassian/platform`. */
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

/** Declare one with `channel<Event>()` to type what is published and received. */
export type ChannelConfig<Event = unknown> = Payload<Event>;

/** A file store. `{}` is a private store whose files are kept until deleted. */
export interface StoreConfig {
  /**
   * Serve the store's files from the edge at `/__platform/storage/<store>/<key>`
   * on the app's host, to anyone with the URL (`auth.required` doesn't cover
   * it), with no server in the path. Files are cached as their `cacheControl`
   * says; without one, browsers revalidate on each use. Default `false`.
   */
  public?: boolean;
  /** Delete files not written for this many days, 1-3650. Checked daily. Default: kept until deleted. */
  expireAfterDays?: number;
}

/**
 * Live updates pushed to browsers. The server and worker publish; browsers
 * subscribe (they never publish). Events aren't stored: a browser that was
 * away re-reads what it shows after reconnecting.
 */
export interface RealtimeConfig {
  /**
   * Who may subscribe: anyone (`public`, the default), or signed-in users of
   * this app (`signed-in`, needs `auth` and `web.server`).
   */
  subscribe?: 'public' | 'signed-in';
  /**
   * Channels and their event types: `board: channel<BoardEvent>()`, or
   * `'boards/*': channel<BoardEvent>()` for every channel below `boards/`.
   * Names are 1-4 segments of a-z, 0-9 and hyphens. `'user/*'` channels
   * (`user/<user id>/...`) are private to that user (`signed-in` only).
   */
  channels: { readonly [pattern: string]: ChannelConfig };
}

/**
 * Transactional email, sent from `<app>@mail.<platform zone>` (previews from
 * `<app>--<stage>@…`). Replies need `replyTo`: the sending address takes no mail.
 */
export interface EmailConfig {
  /** Display name recipients see, e.g. `Todo` → `"Todo" <todo@mail…>`. */
  name?: string;
  /**
   * Recipients per UTC day (default 200), up to the platform's
   * `limits.emailsPerDay`. Previews and `plat dev` get at most 50.
   */
  dailyLimit?: number;
}

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
  /**
   * Named file stores: `{ uploads: {}, snapshots: { public: true, expireAfterDays: 7 } }`.
   * A list of names (`['uploads']`) declares private stores. Keys are 1-20
   * chars of a-z, 0-9 and hyphens. A store can't switch between public and
   * private once it has files: declare a new one instead.
   */
  storage?: readonly string[] | { readonly [name: string]: StoreConfig };
  /** Secret names like `STRIPE_KEY`; values are set with `plat secrets set`. */
  secrets?: readonly string[];
  /** Plain, non-secret configuration exposed as environment variables. */
  env?: { readonly [name: string]: string };
  /** Live updates pushed to browsers on typed channels. */
  realtime?: RealtimeConfig;
  /** Send email with the SDK's `Email` service: `true`, or `{ name, dailyLimit }`. */
  email?: boolean | EmailConfig;
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

/** A realtime channel whose events are `Event`: `realtime: { channels: { board: channel<BoardEvent>() } }`. */
export function channel<Event>(): ChannelConfig<Event> {
  return {};
}

// ---------------------------------------------------------------------------

/**
 * Manifest with defaults applied and derived fields normalized: what
 * deployments store. Decoding fills defaults for fields added since a stored
 * manifest was written, so earlier deployments keep decoding.
 */
export const ResolvedManifest = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  web: Schema.optional(WebSchema),
  /** Present when any queue, event subscription or cron exists. */
  worker: Schema.optional(WorkerSchema),
  auth: Schema.Struct({ enabled: Schema.Boolean, required: Schema.Boolean }),
  db: Schema.Boolean,
  queues: Schema.Record(
    Schema.String,
    Schema.Struct({ ...QueueSchema.fields, visibilityTimeoutSeconds: Schema.Finite }),
  ),
  events: Schema.Array(Schema.String),
  crons: Schema.Record(
    Schema.String,
    Schema.Struct({ schedule: Schema.String, timezone: Schema.optional(Schema.String) }),
  ),
  /** Every store's name. */
  storage: Schema.Array(Schema.String),
  /**
   * Each store's options, by name. Absent from deployments recorded before
   * stores had any: those stores are private and kept until deleted. A field
   * of its own, so clients that know only `storage` keep decoding manifests.
   */
  storageOptions: Schema.Record(
    Schema.String,
    Schema.Struct({ public: Schema.Boolean, expireAfterDays: Schema.optional(Schema.Finite) }),
  ).pipe(orElse({})),
  secrets: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  /** Present when the stage has a channel namespace. `channels` are the declared patterns. */
  realtime: Schema.optional(
    Schema.Struct({ subscribe: RealtimeSubscribeSchema, channels: Schema.Array(Schema.String) }),
  ),
  /** Present when the stage sends email. `dailyLimit` is the declared one (prod's). */
  email: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String), dailyLimit: Schema.Finite })),
});
export type ResolvedManifest = typeof ResolvedManifest.Type;

export class ManifestError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid ${APP_CONFIG_FILE}:\n  - ${issues.join('\n  - ')}`);
    this.issues = issues;
  }
}

const validateManifest = Schema.toStandardSchemaV1(ManifestSchema, { parseOptions: { errors: 'all' } })[
  '~standard'
].validate;

export function parseManifest(input: unknown): ResolvedManifest {
  const result = validateManifest(input);
  // The schema has no asynchronous checks, so validation is synchronous.
  if (result instanceof Promise) throw new Error('manifest validation must be synchronous');
  if (result.issues) {
    throw new ManifestError(
      result.issues.map((i) => {
        const path = (i.path ?? []).map((p) => String(typeof p === 'object' ? p.key : p)).join('.');
        return `${path || '(root)'}: ${i.message}`;
      }),
    );
  }
  return resolveManifest(result.value);
}

export function resolveManifest(m: Manifest): ResolvedManifest {
  const events = Array.isArray(m.events) ? m.events : Object.keys(m.events);
  const needsWorker =
    Object.keys(m.queues).length > 0 || events.length > 0 || Object.keys(m.crons).length > 0;
  const worker = m.worker ?? (needsWorker ? Schema.decodeUnknownSync(WorkerSchema)({}) : undefined);
  const auth =
    typeof m.auth === 'boolean'
      ? { enabled: m.auth, required: false }
      : { enabled: true, required: m.auth.required };
  const queues: ResolvedManifest['queues'] = Object.fromEntries(
    Object.entries(m.queues).map(([key, q]) => [
      key,
      { ...q, visibilityTimeoutSeconds: q.visibilityTimeoutSeconds ?? (worker?.timeoutSeconds ?? 60) * 6 },
    ]),
  );
  const email: ResolvedManifest['email'] =
    m.email === false
      ? undefined
      : {
          ...(m.email !== true && m.email.name ? { name: m.email.name } : {}),
          dailyLimit: (m.email !== true && m.email.dailyLimit) || EMAIL_DEFAULT_DAILY_LIMIT,
        };
  const crons: ResolvedManifest['crons'] = Object.fromEntries(
    Object.entries(m.crons).map(([key, c]) => [key, typeof c === 'string' ? { schedule: c } : c]),
  );
  const stores: Record<string, typeof StoreSchema.Type> = isStoreList(m.storage)
    ? Object.fromEntries(m.storage.map((name) => [name, { public: false }]))
    : m.storage;
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
    storage: Object.keys(stores),
    storageOptions: stores,
    secrets: [...new Set(m.secrets)],
    env: m.env,
    ...(m.realtime
      ? { realtime: { subscribe: m.realtime.subscribe, channels: Object.keys(m.realtime.channels) } }
      : {}),
    ...(email ? { email } : {}),
  };
}

const isStoreList = (storage: Manifest['storage']): storage is readonly string[] => Array.isArray(storage);

/** The stores the edge serves (`public: true`). */
export function publicStores(m: Pick<ResolvedManifest, 'storage' | 'storageOptions'>): string[] {
  return m.storage.filter((name) => m.storageOptions[name]?.public === true);
}
