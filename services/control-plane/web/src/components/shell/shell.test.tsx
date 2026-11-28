import { screen, waitFor, within } from '@testing-library/react';
import { createAgent } from '@ui-sdk/react/agent';
import { expect, test } from 'vitest';
import { renderConsole } from '../../test/render.tsx';

const agent = createAgent();

test("an app's sidebar names every page it has, and only those", async () => {
  await renderConsole('/apps/atlas/settings', 'Settings');
  const nav = await screen.findByRole('navigation', { name: 'atlas pages' });
  const pages = [
    'Overview',
    'Deployments',
    'Logs',
    'Traces',
    'Metrics',
    'Errors',
    'Alerts, 1 firing',
    'Jobs',
    'Database',
    'Storage',
    'Secrets',
    'Cost',
    'Settings',
  ];
  for (const name of pages) expect(within(nav).getByRole('link', { name })).toBeTruthy();
  // atlas declares no email or realtime, and dashboards are gone.
  expect(within(nav).getAllByRole('link')).toHaveLength(pages.length);
  expect(screen.getByRole('link', { name: 'Settings', current: 'page' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBeNull();
});

test('Find… opens the search, which jumps to a page', async () => {
  const { router } = await renderConsole('/apps/atlas/settings', 'Settings');
  const opened = await agent.act({ steps: [{ ref: 'Find…', action: 'press' }] });
  expect(opened.ok, opened.error?.message).toBe(true);
  const search = await screen.findByRole('combobox', { name: 'Search pages, apps and traces' });
  expect(search).toBeTruthy();
  const ran = await agent.act({
    steps: [{ ref: 'Search pages, apps and traces', action: 'run', args: ['Logs'] }],
  });
  expect(ran.ok, ran.error?.message).toBe(true);
  await waitFor(() => expect(router.state.location.pathname).toBe('/apps/atlas/logs'));
});

test('the account menu switches the color scheme', async () => {
  await renderConsole('/', 'Apps');
  const result = await agent.act({ steps: [{ ref: 'Account: demo', action: 'press', args: ['Dark'] }] });
  expect(result.ok, result.error?.message).toBe(true);
  await waitFor(() => expect(document.documentElement.dataset.colorScheme).toBe('dark'));
});
