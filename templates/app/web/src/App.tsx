import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { Todo } from '../../src/types.ts';
import { api, signInUrl, signOutUrl } from './api.ts';

type User = { id: string; email?: string; name?: string };

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.todos.$get();
    if (res.ok) setTodos((await res.json()).todos);
  }, []);

  useEffect(() => {
    void (async () => {
      const res = await api.me.$get();
      const me = res.ok ? (await res.json()).user : null;
      setUser(me);
      if (me) await load();
    })();
  }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await api.todos.$post({ json: { title } });
    if (!res.ok) {
      setError('Could not add that todo.');
      return;
    }
    setTitle('');
    await load();
  }

  async function toggle(todo: Todo) {
    await api.todos[':id'].$patch({ param: { id: todo.id }, json: { done: !todo.done } });
    await load();
  }

  async function remove(todo: Todo) {
    await api.todos[':id'].$delete({ param: { id: todo.id } });
    await load();
  }

  if (user === undefined) return <main className="card">Loading…</main>;

  if (!user) {
    return (
      <main className="card">
        <h1>template-app</h1>
        <p>Sign in to keep a todo list.</p>
        <a className="button" href={signInUrl()}>
          Sign in
        </a>
      </main>
    );
  }

  return (
    <main className="card">
      <header>
        <h1>Todos</h1>
        <span>
          {user.email ?? user.name ?? user.id} · <a href={signOutUrl()}>Sign out</a>
        </span>
      </header>
      <form onSubmit={add}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          required
        />
        <button type="submit">Add</button>
      </form>
      {error && <p className="error">{error}</p>}
      <ul>
        {todos.map((t) => (
          <li key={t.id}>
            <label>
              <input type="checkbox" checked={t.done} onChange={() => void toggle(t)} />
              <span className={t.done ? 'done' : undefined}>{t.title}</span>
            </label>
            <button
              type="button"
              className="link"
              onClick={() => void remove(t)}
              aria-label={`Delete ${t.title}`}
            >
              ✕
            </button>
          </li>
        ))}
        {todos.length === 0 && <li className="empty">Nothing yet.</li>}
      </ul>
    </main>
  );
}
