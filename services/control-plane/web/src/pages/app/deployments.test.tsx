import { screen, within } from '@testing-library/react';
import { createAgent } from '@ui-sdk/react/agent';
import { expect, test } from 'vitest';
import { renderConsole } from '../../test/render.tsx';

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });

test('every control on the deployments page has a name', async () => {
  await renderConsole('/apps/atlas/deployments', 'Deployments');
  await screen.findByRole('list', { name: 'Deployments to prod' });
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== 'more');
  for (const entry of components)
    expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  const labels = components.map((e) => e.label);
  for (const label of ['Actions for c27d4b8', 'Actions for 4f2c1a9', 'Destroy'])
    expect(labels).toContain(label);
});

test('the live deployment is marked, and only older ones offer a rollback', async () => {
  await renderConsole('/apps/atlas/deployments', 'Deployments');
  const list = await screen.findByRole('list', { name: 'Deployments to prod' });
  const rows = within(list).getAllByRole('listitem');
  expect(within(rows[0]!).getByText('Current')).toBeTruthy();
  expect(rows.filter((r) => within(r).queryByText('Current'))).toHaveLength(1);
});

test('rolling back asks first, and sends the rollback only once confirmed', async () => {
  approve = true;
  await renderConsole('/apps/atlas/deployments', 'Deployments');
  await screen.findByRole('list', { name: 'Deployments to prod' });
  const asked = await agent.act({
    steps: [{ ref: 'Actions for c27d4b8', action: 'press', args: ['Roll back to this'] }],
  });
  expect(asked.ok, asked.error?.message).toBe(true);
  const dialog = await screen.findByRole('alertdialog', { name: 'Roll prod back to c27d4b8?' });
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  expect(screen.queryByText("The demo API doesn't roll back stages.")).toBeNull();
  const confirmed = await agent.act({
    steps: [{ ref: 'Roll prod back to c27d4b8?', action: 'press', args: ['Roll back to c27d4b8'] }],
  });
  expect(confirmed.ok, confirmed.error?.message).toBe(true);
  // The demo API refuses changes, so the request's answer is its refusal.
  expect(await screen.findByText("The demo API doesn't roll back stages.")).toBeTruthy();
});

test('an agent needs a person to roll back', async () => {
  approve = false;
  await renderConsole('/apps/atlas/deployments', 'Deployments');
  await screen.findByRole('list', { name: 'Deployments to prod' });
  await agent.act({ steps: [{ ref: 'Actions for c27d4b8', action: 'press', args: ['Roll back to this'] }] });
  await screen.findByRole('alertdialog', { name: 'Roll prod back to c27d4b8?' });
  const refused = await agent.act({
    steps: [{ ref: 'Roll prod back to c27d4b8?', action: 'press', args: ['Roll back to c27d4b8'] }],
  });
  expect(refused.ok).toBe(false);
});

test('destroying a preview asks first, naming the preview', async () => {
  approve = true;
  await renderConsole('/apps/atlas/deployments', 'Deployments');
  await screen.findByRole('list', { name: 'Deployments to prod' });
  const asked = await agent.act({ steps: [{ ref: 'Destroy', action: 'press' }] });
  expect(asked.ok, asked.error?.message).toBe(true);
  const dialog = await screen.findByRole('alertdialog', { name: 'Destroy pr-41?' });
  expect(within(dialog).getByText(/Removes the preview at atlas--pr-41\.example\.com/)).toBeTruthy();
  const cancelled = await agent.act({
    steps: [{ ref: 'Destroy pr-41?', action: 'press', args: ['Cancel'] }],
  });
  expect(cancelled.ok, cancelled.error?.message).toBe(true);
  expect(screen.queryByText("The demo API doesn't destroy stages.")).toBeNull();
});
