import { TAGS } from '@ericminassian/platform-core';
import type { AwsClients } from './clients.ts';

export type EngineLog = (level: 'info' | 'warn' | 'error', msg: string, resource?: string) => void;

/** What every driver receives. */
export interface EngineContext {
  clients: AwsClients;
  region: string;
  target: 'aws' | 'emulator';
  log: EngineLog;
  accountId(): Promise<string>;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function errorName(e: unknown): string {
  const err = e as { name?: string; Code?: string; code?: string; __type?: string } | undefined;
  return err?.name ?? err?.Code ?? err?.code ?? err?.__type ?? '';
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const NOT_FOUND = new Set([
  'ResourceNotFoundException',
  'ResourceNotFound',
  'NoSuchEntity',
  'NoSuchEntityException',
  'NotFoundException',
  'NotFound',
  'NoSuchBucket',
  'NoSuchKey',
  'ParameterNotFound',
  'QueueDoesNotExist',
  'AWS.SimpleQueueService.NonExistentQueue',
  'NoSuchHostedZone',
  'NoSuchFunctionExists',
  'NoSuchOriginAccessControl',
  'NoSuchCachePolicy',
  'NoSuchDistribution',
  'EntityNotFound',
]);

export function isNotFound(e: unknown): boolean {
  const name = errorName(e);
  if (NOT_FOUND.has(name)) return true;
  const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status === 404 && !name.includes('Conflict');
}

export function isNotImplemented(e: unknown): boolean {
  return errorName(e) === 'NotImplemented' || /not implemented/i.test(errorMessage(e));
}

/** Swallow not-found errors (for deletes and probes). */
export async function ignoreNotFound<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    if (isNotFound(e)) return undefined;
    throw e;
  }
}

/** Poll until `fn` returns a truthy value. */
export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined | null | false>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  let interval = opts.intervalMs ?? 500;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(interval);
    interval = Math.min(interval * 1.5, 5_000);
  }
}

/** Retry while `when(error)` is true (e.g. IAM eventual consistency). */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { when: (e: unknown) => boolean; attempts?: number; delayMs?: number },
): Promise<T> {
  const attempts = opts.attempts ?? 10;
  let delay = opts.delayMs ?? 1_000;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !opts.when(e)) throw e;
      await sleep(delay);
      delay = Math.min(delay * 1.5, 10_000);
    }
  }
}

/** Run async work over items with bounded concurrency. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

// ------------------------------------------------------------------ tags

export function stageTags(app: string, stage: string): Record<string, string> {
  return { [TAGS.managed]: 'true', [TAGS.app]: app, [TAGS.stage]: stage };
}

export function platformTags(component: string): Record<string, string> {
  return { [TAGS.managed]: 'true', 'platform:component': component };
}

export function tagList(tags: Record<string, string>): { Key: string; Value: string }[] {
  return Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
}

export function tagListLower(tags: Record<string, string>): { key: string; value: string }[] {
  return Object.entries(tags).map(([key, value]) => ({ key, value }));
}

// ------------------------------------------------------------------ arns

export interface PolicyStatement {
  Sid?: string;
  Effect: 'Allow' | 'Deny';
  Action: string | string[];
  Resource?: string | string[];
  NotResource?: string | string[];
  Principal?: Record<string, string | string[]>;
  Condition?: Record<string, Record<string, string | string[] | boolean>>;
}

export interface PolicyDocument {
  Version: '2012-10-17';
  Statement: PolicyStatement[];
}

export function policy(...statements: PolicyStatement[]): PolicyDocument {
  return { Version: '2012-10-17', Statement: statements };
}

/** Deep-equal for policy documents that may come back URL-encoded from IAM. */
export function samePolicy(a: string | PolicyDocument | undefined, b: PolicyDocument): boolean {
  if (!a) return false;
  const parsed = typeof a === 'string' ? JSON.parse(decodeURIComponent(a)) : a;
  return canonical(parsed) === canonical(b);
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
