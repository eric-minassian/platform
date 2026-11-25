import { screen } from '@testing-library/react';
import { createAgent } from '@ui-sdk/react/agent';
import { expect, test } from 'vitest';
import { renderConsole } from '../../test/render.tsx';

const agent = createAgent();

test("a deployment's page shows where it came from, its events and manifest", async () => {
  await renderConsole('/apps/atlas/deployments/dep_atlas_prod_c27d4b8a', /c27d4b8a/);
  expect(await screen.findByText('Guard missing feed URL', { selector: 'div' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Event log' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Manifest' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'c27d4b8' }).getAttribute('href')).toBe(
    'https://github.com/example/atlas/commit/c27d4b8a31',
  );
  const labels = agent
    .snapshot()
    .filter((e) => !e.offPage && e.component !== 'more')
    .map((e) => e.label);
  // Not live, so it can be rolled back to; the live one can't.
  expect(labels).toContain('Roll prod back to this');
});

test('the live deployment offers no rollback to itself', async () => {
  await renderConsole('/apps/atlas/deployments/dep_atlas_prod_4f2c1a90', /4f2c1a90/);
  await screen.findByText('Current');
  expect(screen.queryByRole('button', { name: /Roll prod back/ })).toBeNull();
});
