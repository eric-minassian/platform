import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { loginUrl, logoutUrl, type User } from '@ericminassian/platform/api';
import { Exit } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { type SubmitEvent, useState } from 'react';
import type { Todo } from '../../src/domain.ts';
import { ApiClient } from './client.ts';

// Mutations name the reactivity key, and the list query re-runs when one succeeds.
const todosChanged = ['todos'];

const me = ApiClient.query('system', 'me', {});
const todos = ApiClient.query('todos', 'list', { reactivityKeys: todosChanged });
const createTodo = ApiClient.mutation('todos', 'create');
const updateTodo = ApiClient.mutation('todos', 'update');
const removeTodo = ApiClient.mutation('todos', 'remove');

export function App() {
  return AsyncResult.match(useAtomValue(me), {
    onInitial: () => <main className="card">Loading…</main>,
    onFailure: () => (
      <main className="card">
        <p className="error">Could not reach the server.</p>
      </main>
    ),
    onSuccess: ({ value: user }) => (user ? <TodoList user={user} /> : <SignIn />),
  });
}

function SignIn() {
  return (
    <main className="card">
      <h1>template-app</h1>
      <p>Sign in to keep a todo list.</p>
      <a className="button" href={loginUrl(window.location.pathname)}>
        Sign in
      </a>
    </main>
  );
}

function TodoList({ user }: { user: User }) {
  const list = useAtomValue(todos);
  const create = useAtomSet(createTodo, { mode: 'promiseExit' });
  const update = useAtomSet(updateTodo, { mode: 'promiseExit' });
  const remove = useAtomSet(removeTodo, { mode: 'promiseExit' });
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = title.trim();
    if (trimmed) void add(trimmed);
  }

  async function add(trimmed: string) {
    setError(null);
    const exit = await create({ payload: { title: trimmed }, reactivityKeys: todosChanged });
    if (Exit.isFailure(exit)) setError('Could not add that todo.');
    else setTitle('');
  }

  async function toggle(todo: Todo) {
    const exit = await update({
      params: { id: todo.id },
      payload: { done: !todo.done },
      reactivityKeys: todosChanged,
    });
    if (Exit.isFailure(exit)) setError('Could not update that todo.');
  }

  async function del(todo: Todo) {
    const exit = await remove({ params: { id: todo.id }, reactivityKeys: todosChanged });
    if (Exit.isFailure(exit)) setError('Could not delete that todo.');
  }

  return (
    <main className="card">
      <header>
        <h1>Todos</h1>
        <span>
          {user.email ?? user.name ?? user.id} · <a href={logoutUrl()}>Sign out</a>
        </span>
      </header>
      <form onSubmit={submit}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          maxLength={200}
          required
        />
        <button type="submit">Add</button>
      </form>
      {error && <p className="error">{error}</p>}
      <TodoItems list={list} onToggle={(t) => void toggle(t)} onDelete={(t) => void del(t)} />
    </main>
  );
}

function TodoItems({
  list,
  onToggle,
  onDelete,
}: {
  list: AsyncResult.AsyncResult<ReadonlyArray<Todo>, unknown>;
  onToggle: (todo: Todo) => void;
  onDelete: (todo: Todo) => void;
}) {
  return AsyncResult.match(list, {
    onInitial: () => null,
    onFailure: () => <p className="error">Could not load your todos.</p>,
    onSuccess: ({ value }) => (
      <ul>
        {value.map((t) => (
          <li key={t.id}>
            <label>
              <input type="checkbox" checked={t.done} onChange={() => onToggle(t)} />
              <span className={t.done ? 'done' : undefined}>{t.title}</span>
            </label>
            <button
              type="button"
              className="link"
              onClick={() => onDelete(t)}
              aria-label={`Delete ${t.title}`}
            >
              ✕
            </button>
          </li>
        ))}
        {value.length === 0 && <li className="empty">Nothing yet.</li>}
      </ul>
    ),
  });
}
