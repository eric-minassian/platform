import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAgent } from '@ui-sdk/react/agent';
import { expect, test } from 'vitest';
import { expectNamed } from '../../test/agent.ts';
import { renderConsole } from '../../test/render.tsx';

const agent = createAgent();

test('logs: search, the three modes, facets by name, and the lines', async () => {
  await renderConsole('/apps/atlas/logs', 'Logs');
  await screen.findByRole('listbox', { name: 'Log lines' });
  const labels = expectNamed(agent);
  for (const label of ['Mode', 'Search log lines', 'error', 'worker', '5xx', 'Log lines'])
    expect(labels).toContain(label);
  // Saved views and dashboards are gone.
  expect(screen.queryByRole('button', { name: /save view|saved views|add to dashboard/i })).toBeNull();
});

test('logs: a facet becomes a filter in the URL', async () => {
  const { router } = await renderConsole('/apps/atlas/logs', 'Logs');
  await screen.findByRole('checkbox', { name: 'error' });
  const checked = await agent.act({ steps: [{ ref: 'error', action: 'setChecked', args: [true] }] });
  expect(checked.ok, checked.error?.message).toBe(true);
  await waitFor(() => expect(router.state.location.search).toMatchObject({ f: { levels: ['error'] } }));
});

test('logs: a line opens beside the list, and ↓ moves to the next one', async () => {
  await renderConsole('/apps/atlas/logs', 'Logs');
  const list = await screen.findByRole('listbox', { name: 'Log lines' });
  const [first, second] = within(list).getAllByRole('option');
  await userEvent.click(first!);
  // A panel beside the list, or a drawer when the page is narrow.
  const panel = await screen.findByLabelText('Log line');
  expect(within(panel).getByText('Raw')).toBeTruthy();
  expect(within(panel).getByRole('button', { name: 'Show context' })).toBeTruthy();
  await userEvent.keyboard('{ArrowDown}');
  await waitFor(() => expect(second!.getAttribute('aria-selected')).toBe('true'));
});

test('logs: Insights takes a query of the stage’s own log groups', async () => {
  const { router } = await renderConsole('/apps/atlas/logs', 'Logs');
  const mode = await agent.act({ steps: [{ ref: 'Mode', action: 'setValue', args: ['Insights'] }] });
  expect(mode.ok, mode.error?.message).toBe(true);
  await waitFor(() => expect(router.state.location.search).toHaveProperty('insights'));
});

test('errors: the status filter, and an error’s actions', async () => {
  await renderConsole('/apps/atlas/errors', 'Errors');
  await screen.findByRole('button', { name: 'Resolve' });
  const labels = expectNamed(agent);
  for (const label of ['Status', 'Resolve', 'Ignore', 'Its log lines']) expect(labels).toContain(label);
  expect(screen.getByRole('link', { name: /FetchError/ })).toBeTruthy();
  const resolved = await agent.act({ steps: [{ ref: 'Resolve', action: 'press' }] });
  expect(resolved.ok, resolved.error?.message).toBe(true);
  expect(await screen.findByText('Marked resolved')).toBeTruthy();
});
