import { z } from 'zod';
import { validateCron } from './cron.ts';
import { APP_NAME_PATTERN, ENV_NAME_PATTERN, EVENT_TYPE_PATTERN, RESOURCE_KEY_PATTERN } from './naming.ts';

/**
 * `platform.json`: everything an app needs, in cloud-neutral terms. This is the
 * whole contract between an app repo and the platform; apps contain no
 * infrastructure code. Keep this schema small and stable.
 */
const resourceKey = z.string().regex(RESOURCE_KEY_PATTERN, 'must be 1-20 chars of a-z, 0-9, hyphens');

const WebSchema = z
  .object({
    /** Entry module whose default export is a fetch handler (`{ fetch }` or a Hono app). */
    server: z.string().optional(),
    /** Directory of built static assets (served from the edge). */
    static: z.string().optional(),
    /** Shell command that builds `static` (run by `plat build`). */
    build: z.string().optional(),
    /** Dev server for the frontend, proxied by `plat dev` (e.g. Vite). */
    dev: z.object({ command: z.string(), port: z.number().int().positive() }).optional(),
    /** Serve `index.html` for unknown non-file paths (client-side routing). */
    spa: z.boolean().default(true),
    /** When both `server` and `static` exist, path prefixes handled by the server. */
    serverRoutes: z.array(z.string().startsWith('/')).default(['/api/']),
    timeoutSeconds: z.number().int().min(3).max(900).default(30),
    /** Max concurrent requests per Web Function environment. */
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
  /** Defaults to 6x the worker timeout, as AWS recommends for Lambda consumers. */
  visibilityTimeoutSeconds: z.number().int().min(0).max(43200).optional(),
  maxReceiveCount: z.number().int().min(1).max(1000).default(5),
  /** Max concurrent worker invocations draining this queue. */
  concurrency: z.number().int().min(2).max(1000).optional(),
});

const CronSchema = z.union([z.string(), z.object({ schedule: z.string(), timezone: z.string().optional() })]);

const AuthSchema = z.union([
  z.boolean(),
  z.object({
    /** Require a signed-in user for every non-platform route (`/__platform/*` stays open). */
    required: z.boolean().default(false),
  }),
]);

export const ManifestSchema = z
  .object({
    $schema: z.string().optional(),
    name: z
      .string()
      // Reserved names are enforced when an app is registered (API), not here:
      // the control plane itself is the app named `platform`.
      .regex(APP_NAME_PATTERN, 'must be 3-30 chars of a-z, 0-9, single hyphens'),
    description: z.string().max(200).optional(),
    web: WebSchema.optional(),
    worker: WorkerSchema.optional(),
    auth: AuthSchema.default(false),
    /** One document database per stage; collections are declared in code. */
    db: z.boolean().default(false),
    queues: z.record(resourceKey, QueueSchema).default({}),
    /** Event types the worker subscribes to (anything can be published). */
    events: z.array(z.string().regex(EVENT_TYPE_PATTERN)).default([]),
    crons: z.record(resourceKey, CronSchema).default({}),
    /** Named file stores. */
    storage: z.array(resourceKey).default([]),
    /** Secret names; values are set with `plat secrets set`. */
    secrets: z.array(z.string().regex(ENV_NAME_PATTERN)).default([]),
    /** Plain, non-secret configuration exposed as environment variables. */
    env: z.record(z.string().regex(ENV_NAME_PATTERN), z.string()).default({}),
  })
  .superRefine((m, ctx) => {
    for (const [key, cron] of Object.entries(m.crons)) {
      const err = validateCron(typeof cron === 'string' ? cron : cron.schedule);
      if (err) ctx.addIssue({ code: 'custom', path: ['crons', key], message: err });
    }
  });

export type ManifestInput = z.input<typeof ManifestSchema>;
export type Manifest = z.output<typeof ManifestSchema>;

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
    super(`Invalid platform.json:\n  - ${issues.join('\n  - ')}`);
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
  const needsWorker =
    Object.keys(m.queues).length > 0 || m.events.length > 0 || Object.keys(m.crons).length > 0;
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
    events: [...new Set(m.events)],
    crons,
    storage: [...new Set(m.storage)],
    secrets: [...new Set(m.secrets)],
    env: m.env,
  };
}

/** JSON Schema URL apps reference for editor completion. */
export const MANIFEST_SCHEMA_URL =
  'https://raw.githubusercontent.com/eric-minassian/platform/main/packages/core/platform.schema.json';
