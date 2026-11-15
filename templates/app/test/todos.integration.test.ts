import { db } from '@eric-minassian/platform';
import { createPlatformFetch } from '@eric-minassian/platform/server';
import { describe, expect, it } from 'vitest';
import app from '../src/server.ts';
import type { Todo } from '../src/types.ts';

// Runs under `plat test`: real SDK, real (emulated) DynamoDB/SQS/EventBridge.
const fetchApp = createPlatformFetch(app);

describe('integration', () => {
  it('serves health through the platform wrapper', async () => {
    const res = await fetchApp(new Request('http://localhost/api/health'));
    expect(res.status).toBe(200);
  });

  it('round-trips a todo through the database', async () => {
    const todos = db.collection<Todo>('todos', { partition: 'userId', sort: 'id' });
    const todo: Todo = {
      userId: 'it-user',
      id: `t-${Date.now()}`,
      title: 'from a test',
      done: false,
      createdAt: new Date().toISOString(),
    };
    await todos.put(todo);
    expect(await todos.get({ userId: todo.userId, id: todo.id })).toMatchObject({ title: 'from a test' });
    const page = await todos.query({ userId: todo.userId });
    expect(page.items.map((t) => t.id)).toContain(todo.id);
  });
});
