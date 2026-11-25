import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAgent } from '@ui-sdk/react/agent';
import { expect, test } from 'vitest';
import { expectNamed } from '../../test/agent.ts';
import { renderConsole } from '../../test/render.tsx';

const agent = createAgent();

test('database: an item opens in a panel with its JSON', async () => {
  await renderConsole('/apps/atlas/database', 'Database');
  await screen.findByRole('button', { name: 'Open src_1' });
  expect(expectNamed(agent)).toContain('Partition key value');
  const opened = await agent.act({ steps: [{ ref: 'Open src_1', action: 'press' }] });
  expect(opened.ok, opened.error?.message).toBe(true);
  const panel = await screen.findByRole('dialog');
  expect(within(panel).getByText(/"feedUrl"/)).toBeTruthy();
});

test('storage: a key prefix, submitted, goes in the URL and narrows the listing', async () => {
  const { router } = await renderConsole('/apps/atlas/storage', 'Storage');
  await screen.findByRole('button', { name: 'Download src_2.xml' });
  expectNamed(agent);
  await userEvent.type(screen.getByRole('textbox', { name: 'Key prefix' }), 'uploads/{Enter}');
  await waitFor(() => expect(router.state.location.search).toMatchObject({ prefix: 'uploads/' }));
  // The demo answers any prefix with its files under it.
  expect(await screen.findByRole('button', { name: 'Download uploads/src_1.xml' })).toBeTruthy();
});
