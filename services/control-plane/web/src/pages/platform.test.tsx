import { screen } from '@testing-library/react';
import { createAgent } from '@ui-sdk/react/agent';
import { expect, test } from 'vitest';
import { renderConsole } from '../test/render.tsx';

const agent = createAgent();

test('the platform page shows the account, the edge floor, members and limits', async () => {
  await renderConsole('/platform', 'Platform');
  for (const heading of ['Account cost per day', 'Edge floor', 'Members', 'Limits']) {
    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
  }
  expect(screen.getByRole('link', { name: '@demo' })).toBeTruthy();
  for (const entry of agent.snapshot().filter((e) => !e.offPage && e.component !== 'more')) {
    expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  }
});
