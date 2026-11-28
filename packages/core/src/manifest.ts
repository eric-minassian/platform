import { Effect, Schema } from 'effect';
import { validateCron } from './cron.ts';
import { EMAIL_DEFAULT_DAILY_LIMIT, EMAIL_NAME_MESSAGE, EMAIL_NAME_PATTERN } from './email.ts';
import { DEFAULT_ATTEMPTS, MAX_ATTEMPTS } from './jobs.ts';
import {
  APP_NAME_PATTERN,
  ENV_NAME_PATTERN,
  EVENT_TYPE_PATTERN,
  names,
  RESOURCE_KEY_PATTERN,
} from './naming.ts';
import { CHANNEL_DECLARATION_PATTERN, CHANNEL_MESSAGE, realtimeIssues } from './realtime.ts';
import { WEB_COMPUTE_SETTINGS, WEB_REQUEST_MEMORY_MB, type WebComputeSetting } from './web-compute.ts';

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
  compute: Schema.Literals(WEB_COMPUTE_SETTINGS).pipe(orElse('auto')),
  memoryMb: intBetween(128, 10240).pipe(orElse(WEB_REQUEST_MEMORY_MB)),
  maxEnvironments: Schema.optional(intBetween(2, 10000)),
}).check(
  Schema.makeFilter((w) =>
    w.server || w.static ? undefined : 'web needs a server, a static directory, or both',
  ),
);

const WORKER_TIMEOUT_SECONDS = 60;
const WORKER_MEMORY_MB = 512;
const timeoutSeconds = intBetween(1, 900);
const memoryMb = intBetween(128, 10240);

const WorkerSchema = Schema.Struct({
  entry: Schema.String.pipe(orElse('src/worker.ts')),
  timeoutSeconds: timeoutSeconds.pipe(orElse(WORKER_TIMEOUT_SECONDS)),
  memoryMb: memoryMb.pipe(orElse(WORKER_MEMORY_MB)),
});

/** A queue, event or cron handler's own settings; unset ones are the worker's. */
const HandlerFields = {
  timeoutSeconds: Schema.optional(timeoutSeconds),
  memoryMb: Schema.optional(memoryMb),
};
const attempts = intBetween(1, MAX_ATTEMPTS);
/** An event handler's settings. Unset attempts are `DEFAULT_ATTEMPTS.event`. */
const HandlerSchema = Schema.Struct({ ...HandlerFields, maxAttempts: Schema.optional(attempts) });

const QueueFields = {
  maxAttempts: attempts.pipe(orElse(DEFAULT_ATTEMPTS.queue)),
  concurrency: Schema.optional(intBetween(1, 1000)),
  ...HandlerFields,
};

/** A field that was removed: present at all, it fails with `message`. */
const removed = (message: string) => Schema.optional(Schema.Unknown.check(Schema.makeFilter(() => message)));

// Queues were SQS queues polled by Lambda until 0.4.0; these settings had no meaning after.
const QueueSchema = Schema.Struct({
  ...QueueFields,
  batchSize: removed('removed in 0.4.0: a queue delivers one message per run'),
  visibilityTimeoutSeconds: removed("removed in 0.4.0: a run has its handler's timeoutSeconds"),
  maxReceiveCount: removed('renamed to maxAttempts in 0.4.0'),
});

const CronScheduleSchema = Schema.Struct({
  schedule: Schema.String,
  timezone: Schema.optional(Schema.String),
  maxAttempts: Schema.optional(attempts),
  ...HandlerFields,
});

const CronSchema = Schema.Union([Schema.String, CronScheduleSchema]).check(
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
  listed: Schema.Boolean.pipe(orElse(true)),
  web: Schema.optional(WebSchema),
  worker: Schema.optional(WorkerSchema),
  auth: AuthSchema.pipe(orElse(false)),
  db: Schema.Boolean.pipe(orElse(false)),
  queues: recordOf(RESOURCE_KEY_PATTERN, QueueSchema, RESOURCE_KEY_MESSAGE).pipe(orElse({})),
  // The array form predates typed event payloads; deployments recorded
  // before then still store it.
  events: Schema.Union([Schema.Array(eventType), recordOf(EVENT_TYPE_PATTERN, HandlerSchema)]).pipe(
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
  // Long-running services ran on Fargate until 0.5.0. Each paid for its vCPU, memory and public
  // IPv4 address all month, the only part of an app billed while idle.
  services: removed(
    'removed in 0.5.0: hold a connection from a cron instead, listening for a while each run',
  ),
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
  /** Max concurrent requests per Web Function environment (instance mode), 1-128. Default 64. */
  concurrency?: number;
  /**
   * How the server runs. `request`: one invocation per request, billed by the
   * millisecond and nothing while idle. `instance`: a Web Function, whose
   * environments serve many requests at once and are billed for their memory
   * while they live (until about five minutes after the last request).
   * `auto` (default): previews run `request`; prod starts on `request` and
   * moves to whichever mode its traffic makes cheaper, checked daily.
   */
  compute?: WebComputeSetting;
  /** Memory of the server in request mode, 128-10240 MB (CPU grows with it). Default 1024. */
  memoryMb?: number;
  /** Most environments prod's Web Function (instance mode) runs at once, 2-10000. Default 10; previews 2. */
  maxEnvironments?: number;
}

export interface WorkerConfig {
  /** Module whose default export is `defineWorker(...)`. Default `src/worker.ts`. */
  entry?: string;
  /** 1-900. Default 60. Handlers can set their own (`HandlerConfig`). */
  timeoutSeconds?: number;
  /** 128-10240. Default 512. Handlers can set their own (`HandlerConfig`). */
  memoryMb?: number;
}

/**
 * A queue, event or cron handler's own Lambda settings, for handlers whose
 * needs differ from the rest (a big parse, a long idle wait). A handler that
 * sets either runs in a function of its own, from the same worker bundle;
 * the one it doesn't set is the worker's.
 */
export interface HandlerConfig {
  /** 1-900. Default: the worker's `timeoutSeconds`. */
  timeoutSeconds?: number;
  /** 128-10240. Default: the worker's `memoryMb`. */
  memoryMb?: number;
}

/** How often a failed run is tried again, for every kind of handler. */
export interface RetryConfig {
  /**
   * Runs before the job goes to the stage's dead-letter queue, 1-100: the
   * first, then retries 1, 2, 4 … minutes apart (at most an hour). Default 5
   * for queues, 3 for events and crons.
   */
  maxAttempts?: number;
}

/**
 * Declare one with `queue<Body>({ ... })` to type what is sent and received.
 * Each message is one run of its handler, at least once and in no set order.
 */
export interface QueueConfig<Body = unknown> extends Payload<Body>, HandlerConfig, RetryConfig {
  /**
   * At most this many runs at once, 1-1000. Setting it runs the handler in a
   * function of its own with that much reserved Lambda concurrency; messages
   * past it wait (up to six hours) instead of failing.
   */
  concurrency?: number;
}

/** Event handler options. */
export type EventOptions = HandlerConfig & RetryConfig;

/** Declare one with `event<Detail>()` to type what is published and handled. */
export type EventConfig<Detail = unknown> = Payload<Detail> & EventOptions;

/**
 * 5-field cron in UTC (`0 3 * * *`) or `rate(5 minutes)`; the object form adds
 * a timezone or the handler's own settings.
 */
export type CronConfig = string | CronSchedule;

export interface CronSchedule extends HandlerConfig, RetryConfig {
  schedule: string;
  /** IANA name, e.g. `America/Los_Angeles`. Default UTC. */
  timezone?: string;
}

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
  /** One line, up to 200 chars. The public directory shows it next to the app. */
  description?: string;
  /**
   * Whether the platform's public directory (`GET /v1/public/apps`) lists the
   * prod stage, with its page views. Default true; `false` keeps the app out.
   */
  listed?: boolean;
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

/** A queue whose messages are `Body`: `queues: { emails: queue<EmailJob>({ maxAttempts: 3 }) }`. */
export function queue<Body>(options: QueueConfig = {}): QueueConfig<Body> {
  return options as QueueConfig<Body>;
}

/** An event subscription whose detail is `Detail`: `events: { 'todo.created': event<TodoCreated>() }`. */
export function event<Detail>(options: EventOptions = {}): EventConfig<Detail> {
  return options;
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
  /** Listed in the public directory (prod only). Deployments recorded before it existed were. */
  listed: Schema.Boolean.pipe(orElse(true)),
  web: Schema.optional(WebSchema),
  /** Present when any queue, event subscription or cron exists. */
  worker: Schema.optional(WorkerSchema),
  auth: Schema.Struct({ enabled: Schema.Boolean, required: Schema.Boolean }),
  db: Schema.Boolean,
  queues: Schema.Record(Schema.String, Schema.Struct(QueueFields)),
  events: Schema.Array(Schema.String),
  /**
   * Each event handler's own settings, by type. Absent from deployments
   * recorded before handlers had any. A field of its own, so clients that
   * know only `events` keep decoding manifests.
   */
  eventOptions: Schema.Record(Schema.String, HandlerSchema).pipe(orElse({})),
  crons: Schema.Record(Schema.String, CronScheduleSchema),
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
  const eventOptions: ResolvedManifest['eventOptions'] = isEventList(m.events)
    ? Object.fromEntries(m.events.map((type) => [type, {}]))
    : m.events;
  const events = Object.keys(eventOptions);
  const needsWorker =
    Object.keys(m.queues).length > 0 || events.length > 0 || Object.keys(m.crons).length > 0;
  const worker = m.worker ?? (needsWorker ? Schema.decodeUnknownSync(WorkerSchema)({}) : undefined);
  const auth =
    typeof m.auth === 'boolean'
      ? { enabled: m.auth, required: false }
      : { enabled: true, required: m.auth.required };
  // Validation refused the removed queue settings, so only the current ones remain.
  const queues: ResolvedManifest['queues'] = Object.fromEntries(
    Object.entries(m.queues).map(([key, q]) => [
      key,
      {
        maxAttempts: q.maxAttempts,
        ...(q.concurrency !== undefined ? { concurrency: q.concurrency } : {}),
        ...(q.timeoutSeconds !== undefined ? { timeoutSeconds: q.timeoutSeconds } : {}),
        ...(q.memoryMb !== undefined ? { memoryMb: q.memoryMb } : {}),
      },
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
    listed: m.listed,
    ...(m.web ? { web: m.web } : {}),
    ...(worker ? { worker } : {}),
    auth,
    db: m.db,
    queues,
    events,
    eventOptions,
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
const isEventList = (events: Manifest['events']): events is readonly string[] => Array.isArray(events);

/** The stores the edge serves (`public: true`). */
export function publicStores(m: Pick<ResolvedManifest, 'storage' | 'storageOptions'>): string[] {
  return m.storage.filter((name) => m.storageOptions[name]?.public === true);
}

// ---------------------------------------------------------------------------
// Worker functions

const HANDLER_KINDS = ['queue', 'event', 'cron'] as const;
export type HandlerKind = (typeof HANDLER_KINDS)[number];

/** A queue, event or cron handler and the settings it runs with. */
export interface HandlerSettings {
  kind: HandlerKind;
  /** The queue or cron key, or the event type. */
  name: string;
  timeoutSeconds: number;
  memoryMb: number;
  /** Runs before its job is dead-lettered. */
  maxAttempts: number;
  /** Reserved concurrency of its function (queues that set `concurrency`). */
  concurrency?: number;
  /**
   * It sets its own memory, timeout or (a queue) concurrency, so it runs in a
   * function of its own (`names.handlerFunction`).
   */
  own: boolean;
}

type WorkerManifest = Pick<ResolvedManifest, 'worker' | 'queues' | 'eventOptions' | 'crons'>;

/** Each kind's handlers, by name, with what they set. */
const declaredHandlers = (
  m: WorkerManifest,
): Record<
  HandlerKind,
  { readonly [name: string]: HandlerConfig & { maxAttempts?: number; concurrency?: number } }
> => ({
  queue: m.queues,
  event: m.eventOptions,
  cron: m.crons,
});

/** A handler's settings: its own, and the worker's for any it doesn't set. */
export function handlerSettings(m: WorkerManifest, kind: HandlerKind, name: string): HandlerSettings {
  const own = declaredHandlers(m)[kind][name] ?? {};
  // Reserved concurrency is per function, so a queue that caps it needs one to itself.
  const concurrency = kind === 'queue' ? own.concurrency : undefined;
  return {
    kind,
    name,
    timeoutSeconds: own.timeoutSeconds ?? m.worker?.timeoutSeconds ?? WORKER_TIMEOUT_SECONDS,
    memoryMb: own.memoryMb ?? m.worker?.memoryMb ?? WORKER_MEMORY_MB,
    maxAttempts: own.maxAttempts ?? DEFAULT_ATTEMPTS[kind],
    ...(concurrency !== undefined ? { concurrency } : {}),
    own: own.timeoutSeconds !== undefined || own.memoryMb !== undefined || concurrency !== undefined,
  };
}

/** Every queue, event and cron handler with its settings. */
export function workerHandlers(m: WorkerManifest): HandlerSettings[] {
  const declared = declaredHandlers(m);
  return HANDLER_KINDS.flatMap((kind) =>
    Object.keys(declared[kind]).map((name) => handlerSettings(m, kind, name)),
  );
}

/** The handlers that run in functions of their own. The worker's function runs the rest. */
export function ownFunctionHandlers(m: WorkerManifest): HandlerSettings[] {
  return workerHandlers(m).filter((h) => h.own);
}

/** The Lambda function a handler runs in: its own, or the worker's. */
export function handlerFunctionName(
  app: string,
  stage: string,
  m: WorkerManifest,
  kind: HandlerKind,
  name: string,
): string {
  return handlerSettings(m, kind, name).own
    ? names.handlerFunction(app, stage, kind, name)
    : names.workerFunction(app, stage);
}
