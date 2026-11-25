import { screen, within } from '@testing-library/react';
import { createAgent } from '@ui-sdk/react/agent';
import { expect, test } from 'vitest';
import { renderConsole } from '../test/render.tsx';

const agent = createAgent();

test('every control on the apps page has a name an agent can find', async () => {
  await renderConsole('/', 'Apps');
  await screen.findByRole('link', { name: 'atlas' });
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== 'more');
  for (const entry of components)
    expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  const labels = components.map((e) => e.label);
  for (const label of ['Filter apps', 'Find…', 'Fold sidebar', 'Account: demo']) {
    expect(labels, `${label} is missing from the snapshot`).toContain(label);
  }
});

test('filtering narrows the list to matching apps', async () => {
  await renderConsole('/', 'Apps');
  await screen.findByRole('link', { name: 'atlas' });
  const result = await agent.act({ steps: [{ ref: 'Filter apps', action: 'setValue', args: ['inbox'] }] });
  expect(result.ok, result.error?.message).toBe(true);
  const table = screen.getByRole('table');
  expect(within(table).getByRole('link', { name: 'inbox' })).toBeTruthy();
  expect(within(table).queryByRole('link', { name: 'atlas' })).toBeNull();
});
