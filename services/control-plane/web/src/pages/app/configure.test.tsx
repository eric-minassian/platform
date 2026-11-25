import { screen, waitFor, within } from '@testing-library/react';
import { createAgent } from '@ui-sdk/react/agent';
import { expect, test } from 'vitest';
import { expectNamed } from '../../test/agent.ts';
import { renderConsole } from '../../test/render.tsx';

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });

test('secrets: the add form, the missing secret, and each row’s actions', async () => {
  await renderConsole('/apps/atlas/secrets', 'Secrets');
  await screen.findByRole('button', { name: 'Set RANKING_KEY' });
  const labels = expectNamed(agent);
  for (const label of ['Name', 'Value', 'Applies to', 'Actions for FEED_TOKEN', 'Set RANKING_KEY']) {
    expect(labels).toContain(label);
  }
  const value = screen.getByLabelText<HTMLInputElement>('Value');
  expect(value.type, 'a value is typed masked').toBe('password');
  const save = screen.getByRole('button', { name: 'Save' });
  expect(save.hasAttribute('disabled') || save.getAttribute('aria-disabled') === 'true').toBe(true);
});

test('secrets: deleting one asks a person first', async () => {
  approve = false;
  await renderConsole('/apps/atlas/secrets', 'Secrets');
  await screen.findByRole('button', { name: 'Actions for FEED_TOKEN' });
  const opened = await agent.act({
    steps: [{ ref: 'Actions for FEED_TOKEN', action: 'press', args: ['Delete'] }],
  });
  expect(opened.ok, opened.error?.message).toBe(true);
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog.textContent).toContain('FEED_TOKEN');
});

test('settings: each setting saves on its own, once it changed', async () => {
  await renderConsole('/apps/atlas/settings', 'Settings');
  const save = await screen.findByRole('button', { name: 'Save description' });
  const labels = expectNamed(agent);
  for (const label of [
    'Description',
    'Repository',
    'Owners',
    'Save description',
    'Save repository',
    'Save owners',
    'Delete app',
  ]) {
    expect(labels).toContain(label);
  }
  expect(save.hasAttribute('disabled')).toBe(true);
  const typed = await agent.act({
    steps: [{ ref: 'Description', action: 'setValue', args: ['Feeds, indexed'] }],
  });
  expect(typed.ok, typed.error?.message).toBe(true);
  await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
  expect(screen.getByRole('button', { name: 'Save repository' }).hasAttribute('disabled')).toBe(true);
});

test('cost: the month so far, the days, and what each compute mode would cost', async () => {
  await renderConsole('/apps/atlas/cost', 'Cost');
  expect(await screen.findByRole('heading', { name: 'Cost per day' })).toBeTruthy();
  expect(within(document.body).getByText('Month to date')).toBeTruthy();
  expectNamed(agent);
});
