import { screen, within } from '@testing-library/react';
import { createAgent } from '@ui-sdk/react/agent';
import { expect, test } from 'vitest';
import { expectNamed } from '../../test/agent.ts';
import { renderConsole } from '../../test/render.tsx';

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });

test('jobs: dead letters can be redriven and discarded, and discarding asks a person first', async () => {
  approve = false;
  await renderConsole('/apps/atlas/jobs', 'Jobs');
  await screen.findByRole('button', { name: 'Discard all' });
  const labels = expectNamed(agent);
  for (const label of [
    'Run digest now',
    'Redrive all',
    'Discard all',
    'Redrive refresh',
    'Discard refresh',
  ]) {
    expect(labels).toContain(label);
  }
  await agent.act({ steps: [{ ref: 'Discard all', action: 'press' }] });
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  const confirm = within(dialog)
    .getAllByRole('button')
    .find((b) => b.dataset.agentConfirm !== undefined);
  expect(confirm, 'the agreeing button is marked for a person').toBeTruthy();
  const refused = await agent.act({
    steps: [
      {
        ref: dialog.getAttribute('aria-label') ?? 'Discard all',
        action: 'press',
        args: [confirm!.textContent],
      },
    ],
  });
  expect(refused.ok).toBe(false);
});

test('email: removing a suppressed address asks first', async () => {
  await renderConsole('/apps/inbox/email', 'Email');
  await screen.findByRole('button', { name: 'Remove bounced@example.net' });
  expectNamed(agent);
  await agent.act({ steps: [{ ref: 'Remove bounced@example.net', action: 'press' }] });
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog.textContent).toContain('bounced@example.net');
});

test("realtime: the channel's publishes, subscribes and errors", async () => {
  await renderConsole('/apps/notes/realtime', 'Realtime');
  expect(await screen.findByText('notes/*')).toBeTruthy();
  expectNamed(agent);
});
