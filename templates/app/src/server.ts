import { auth, db, events, metrics, app as platform, queue } from '@ericminassian/platform';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import type { Todo } from './types.ts';

// One collection per entity. Partition by user so each user's todos are one query.
// Sort keys are time-ordered ids, so `query` returns oldest first.
const todos = db.collection<Todo>('todos', { partition: 'userId', sort: 'id' });

const NewTodo = z.object({ title: z.string().trim().min(1).max(200) });
const PatchTodo = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  done: z.boolean().optional(),
});

/** Validates a JSON body with a zod schema; the parsed type flows to the typed web client. */
const json = <T extends z.ZodType>(schema: T) =>
  validator('json', (value, c) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'invalid body' }, 400);
    return parsed.data as z.infer<T>;
  });

/** Time-sortable id: 9 chars of base36 ms timestamp + 8 random chars. */
function newId(): string {
  return Date.now().toString(36).padStart(9, '0') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

const api = new Hono()
  .get('/health', (c) => c.json({ ok: true, app: platform.name, stage: platform.stage }))

  .get('/me', async (c) => c.json({ user: await auth.getUser(c.req.raw) }))

  .get('/todos', async (c) => {
    const user = await auth.requireUser(c.req.raw);
    const page = await todos.query({ userId: user.id });
    return c.json({ todos: page.items });
  })

  .post('/todos', json(NewTodo), async (c) => {
    const user = await auth.requireUser(c.req.raw);
    const input = c.req.valid('json');

    const todo: Todo = {
      userId: user.id,
      id: newId(),
      title: input.title,
      done: false,
      createdAt: new Date().toISOString(),
    };
    await todos.put(todo, { ifNotExists: true });
    await events.publish('todo.created', { userId: user.id, id: todo.id, title: todo.title });
    if (user.email) {
      await queue('emails').send({ to: user.email, subject: 'New todo', body: todo.title });
    }
    metrics.count('todos.created');
    return c.json({ todo }, 201);
  })

  .patch('/todos/:id', json(PatchTodo), async (c) => {
    const user = await auth.requireUser(c.req.raw);
    const key = { userId: user.id, id: c.req.param('id') };
    if (!(await todos.get(key))) return c.json({ error: 'not found' }, 404);
    const todo = await todos.update(key, c.req.valid('json'));
    return c.json({ todo });
  })

  .delete('/todos/:id', async (c) => {
    const user = await auth.requireUser(c.req.raw);
    await todos.delete({ userId: user.id, id: c.req.param('id') });
    return c.body(null, 204);
  });

const app = new Hono();

// `auth.requireUser` throws a 401 Response when signed out: send it as-is.
app.use(async (c, next) => {
  try {
    await next();
  } catch (err) {
    if (err instanceof Response) {
      c.res = err;
      return;
    }
    throw err;
  }
});
app.route('/api', api);

// Anything else is a bug: rethrow so the platform records it (error group, trace
// id, stack) and answers 500, instead of Hono swallowing it.
app.onError((err) => {
  throw err;
});

/** Typed client for the frontend: `hc<ApiType>('/api')` from `hono/client`. */
export type ApiType = typeof api;

export default app;
