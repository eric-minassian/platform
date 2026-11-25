import { createMemoryHistory } from '@tanstack/react-router';
import { act, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { App } from '../app.tsx';
import { createConsoleRouter } from '../router.tsx';

async function renderLogin(search: string) {
  const router = createConsoleRouter(createMemoryHistory({ initialEntries: [`/login${search}`] }));
  render(<App router={router} />);
  await act(() => router.load());
  await screen.findByRole('heading', { name: 'Sign in' });
}

test('signing in goes through GitHub and comes back to the page asked for', async () => {
  await renderLogin('?redirect=%2Fapps%2Fatlas%2Flogs');
  expect(screen.getByRole('link', { name: 'Sign in with GitHub' }).getAttribute('href')).toBe(
    '/auth/github/login?redirect=%2Fapps%2Fatlas%2Flogs',
  );
});

test('someone the server turned away is told why', async () => {
  await renderLogin('?denied=octocat');
  expect(screen.getByRole('alert').textContent).toContain("@octocat isn't a member");
});
