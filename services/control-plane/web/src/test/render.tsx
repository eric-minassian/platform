import { createMemoryHistory } from '@tanstack/react-router';
import { act, render, screen } from '@testing-library/react';
import { App } from '../app.tsx';
import { createConsoleRouter } from '../router.tsx';

/** Renders the whole console at `path` and waits for the page's heading. */
export async function renderConsole(path: string, heading: string | RegExp) {
  const router = createConsoleRouter(createMemoryHistory({ initialEntries: [path] }));
  const view = render(<App router={router} />);
  await act(() => router.load());
  await screen.findByRole('heading', { level: 1, name: heading }, { timeout: 10_000 });
  return { ...view, router };
}
