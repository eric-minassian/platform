import { describe, expect, it } from 'vitest';
import {
  type AppConfig,
  defineApp,
  event,
  type ManifestInput,
  type PayloadOf,
  parseManifest,
  queue,
} from '../src/index.ts';

// AppConfig (what authors write) and ManifestSchema (what the CLI and API
// validate) are declared separately; these fail `pnpm typecheck` if they drift.
type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Fields the schema still knows only to refuse them with what replaced them. */
type Removed = 'services';
const configFitsSchema: Same<keyof AppConfig, Exclude<keyof ManifestInput, Removed>> = true;
export const _checks = [
  configFitsSchema,
  (c: AppConfig): DeepReadonly<ManifestInput> => c,
  (c: ManifestInput): AppConfig => c,
];

interface EmailJob {
  to: string;
}

describe('defineApp', () => {
  const app = defineApp({
    name: 'todo',
    queues: { emails: queue<EmailJob>({ maxAttempts: 2 }), plain: {} },
    events: { 'todo.created': event<{ id: string }>() },
    crons: { cleanup: '0 3 * * *' },
    storage: ['uploads'],
  });

  it('keeps literal names and payload types', () => {
    const store: 'uploads' | undefined = app.storage[0];
    const body: PayloadOf<typeof app.queues.emails> = { to: 'a' };
    const plain: Same<PayloadOf<typeof app.queues.plain>, unknown> = true;
    expect([store, body, plain]).toEqual(['uploads', { to: 'a' }, true]);
  });

  it('serializes to a manifest the schema accepts', () => {
    const m = parseManifest(JSON.parse(JSON.stringify(app)));
    expect(m.queues.emails?.maxAttempts).toBe(2);
    expect(m.events).toEqual(['todo.created']);
    expect(m.worker?.entry).toBe('src/worker.ts');
  });

  it('rejects unknown fields at compile time', () => {
    // @ts-expect-error misspelled top-level field
    defineApp({ name: 'todo', qeues: {} });
    // @ts-expect-error misspelled queue option
    defineApp({ name: 'todo', queues: { emails: { maxattempts: 5 } } });
    // @ts-expect-error misspelled nested field
    defineApp({ name: 'todo', web: { server: 'src/server.ts', dev: { command: 'vite', prot: 5173 } } });
    // @ts-expect-error misspelled store option
    defineApp({ name: 'todo', storage: { snapshots: { pubic: true } } });
    // @ts-expect-error misspelled handler option
    defineApp({ name: 'todo', crons: { tick: { schedule: 'rate(1 minute)', memoryMB: 256 } } });
    expect(true).toBe(true);
  });

  it('keeps store names and options literal', () => {
    const files = defineApp({
      name: 'atlas',
      storage: { uploads: {}, snapshots: { public: true, expireAfterDays: 7 } },
    });
    const isPublic: true = files.storage.snapshots.public;
    const uploads: Same<typeof files.storage.uploads, {}> = true;
    expect([isPublic, uploads]).toEqual([true, true]);
  });
});

describe('handler settings', () => {
  it('keep payload types', () => {
    const app = defineApp({
      name: 'atlas',
      queues: { ais: queue<EmailJob>({ memoryMb: 256, timeoutSeconds: 90 }) },
      events: { 'ship.seen': event<{ mmsi: number }>({ memoryMb: 256 }) },
      crons: { ais: { schedule: 'rate(1 minute)', memoryMb: 256, timeoutSeconds: 90 } },
    });
    const body: PayloadOf<typeof app.queues.ais> = { to: 'a' };
    const detail: PayloadOf<(typeof app.events)['ship.seen']> = { mmsi: 1 };
    const m = parseManifest(JSON.parse(JSON.stringify(app)));
    expect([body, detail, m.eventOptions['ship.seen'], m.crons.ais?.timeoutSeconds]).toEqual([
      { to: 'a' },
      { mmsi: 1 },
      { memoryMb: 256 },
      90,
    ]);
  });
});

describe('events', () => {
  it('accepts the array form stored by earlier deployments', () => {
    expect(parseManifest({ name: 'todo', events: ['a.b', 'a.b'] }).events).toEqual(['a.b']);
  });
});
