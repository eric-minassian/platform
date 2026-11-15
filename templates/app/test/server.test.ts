import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests replace the platform SDK with in-memory fakes, so they run with no
// emulator and no AWS. Integration tests (`*.integration.test.ts`, `plat test`)
// use the real SDK against the AWS Emulator.
const store = new Map<string, Record<string, unknown>>();
const published: Array<{ type: string; detail: unknown }> = [];
const sent: unknown[] = [];

vi.mock('@ericminassian/platform', () => {
  const userFrom = (req: Request) => {
    const id = req.headers.get('x-test-user');
    return id ? { id, email: `${id}@example.com`, groups: [] } : null;
  };
  return {
    app: {
      name: 'template-app',
      stage: 'test',
      host: 'localhost',
      url: 'http://localhost',
      revision: 'd0',
      isLocal: true,
    },
    auth: {
      getUser: async (req: Request) => userFrom(req),
      requireUser: async (req: Request) => {
        const u = userFrom(req);
        if (!u) throw new Response('unauthorized', { status: 401 });
        return u;
      },
    },
    db: {
      collection: (name: string) => {
        const k = (key: Record<string, unknown>) => `${name}#${key.userId}#${key.id}`;
        return {
          get: async (key: Record<string, unknown>) => store.get(k(key)),
          put: async (item: Record<string, unknown>) => {
            store.set(k(item), item);
            return item;
          },
          update: async (key: Record<string, unknown>, patch: Record<string, unknown>) => {
            const next = { ...store.get(k(key)), ...patch };
            store.set(k(key), next);
            return next;
          },
          delete: async (key: Record<string, unknown>) => void store.delete(k(key)),
          query: async (part: Record<string, unknown>) => ({
            items: [...store.entries()]
              .filter(([key]) => key.startsWith(`${name}#${part.userId}#`))
              .map(([, v]) => v),
          }),
        };
      },
    },
    events: { publish: async (type: string, detail: unknown) => void published.push({ type, detail }) },
    queue: () => ({ send: async (body: unknown) => void sent.push(body), sendBatch: async () => {} }),
    metrics: { count: () => {}, value: () => {} },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
});

const { default: app } = await import('../src/server.ts');

const as = (user: string) => ({ 'x-test-user': user, 'content-type': 'application/json' });

describe('api', () => {
  beforeEach(() => {
    store.clear();
    published.length = 0;
    sent.length = 0;
  });

  it('reports health', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, app: 'template-app' });
  });

  it('requires sign-in for todos', async () => {
    const res = await app.request('/api/todos');
    expect(res.status).toBe(401);
  });

  it('creates, lists, toggles and deletes todos', async () => {
    const created = await app.request('/api/todos', {
      method: 'POST',
      headers: as('u1'),
      body: JSON.stringify({ title: 'Buy milk' }),
    });
    expect(created.status).toBe(201);
    const { todo } = (await created.json()) as { todo: { id: string; done: boolean } };
    expect(published).toEqual([{ type: 'todo.created', detail: expect.objectContaining({ id: todo.id }) }]);
    expect(sent).toHaveLength(1);

    const list = await app.request('/api/todos', { headers: as('u1') });
    expect(((await list.json()) as { todos: unknown[] }).todos).toHaveLength(1);
    const other = await app.request('/api/todos', { headers: as('u2') });
    expect(((await other.json()) as { todos: unknown[] }).todos).toHaveLength(0);

    const patched = await app.request(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: as('u1'),
      body: JSON.stringify({ done: true }),
    });
    expect(((await patched.json()) as { todo: { done: boolean } }).todo.done).toBe(true);

    const deleted = await app.request(`/api/todos/${todo.id}`, { method: 'DELETE', headers: as('u1') });
    expect(deleted.status).toBe(204);
    expect(store.size).toBe(0);
  });

  it('validates input', async () => {
    const res = await app.request('/api/todos', {
      method: 'POST',
      headers: as('u1'),
      body: JSON.stringify({ title: '' }),
    });
    expect(res.status).toBe(400);
  });
});
