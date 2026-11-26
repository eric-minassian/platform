import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAgent } from '@ui-sdk/react/agent';
import { expect, test } from 'vitest';
import { expectNamed } from '../../test/agent.ts';
import { renderConsole } from '../../test/render.tsx';

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });

test('overview: the live deployment leads, then the figures, charts, routes and activity', async () => {
  await renderConsole('/apps/atlas', /^atlas/);
  const card = (await screen.findByRole('heading', { name: 'Production deployment' })).closest('section')!;
  expect(await within(card).findByText('Current')).toBeTruthy();
  expect(within(card).getByRole('link', { name: 'atlas.example.com' })).toBeTruthy();
  for (const heading of [
    'Page views',
    'Requests',
    'Latency',
    '5xx rate',
    'Job runs',
    'Busiest routes',
    'Activity',
  ]) {
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
  }
  const labels = expectNamed(agent);
  for (const label of [
    'Runtime logs',
    'Instant rollback',
    'Deployments',
    'Visit atlas.example.com',
    'More for Requests',
  ]) {
    expect(labels).toContain(label);
  }
  // The latency heatmap moved to Metrics.
  expect(screen.queryByRole('heading', { name: 'Latency distribution' })).toBeNull();
});

test("overview: a chart's menu opens it in Metrics or starts an alert, and nothing else", async () => {
  const { router } = await renderConsole('/apps/atlas', /^atlas/);
  await screen.findByRole('heading', { name: 'Requests' });
  const opened = await agent.act({
    steps: [{ ref: 'More for 5xx rate', action: 'press', args: ['Open in Metrics'] }],
  });
  expect(opened.ok, opened.error?.message).toBe(true);
  await waitFor(() => expect(router.state.location.pathname).toBe('/apps/atlas/metrics'));
  expect(router.state.location.search).toHaveProperty('view');
});

test('metrics: the explorer’s controls, without number or table charts', async () => {
  const { router } = await renderConsole('/apps/atlas/metrics', /./);
  await screen.findByRole('button', { name: 'Copy as CLI' });
  const labels = expectNamed(agent);
  for (const label of [
    'Metric of a',
    'Statistic of a',
    'Group by of a',
    'Chart',
    'Scale',
    'Query',
    'Expression',
  ]) {
    expect(labels).toContain(label);
  }
  const chart = agent.snapshot().find((e) => e.label === 'Chart');
  expect(chart?.items?.map((i) => i.label)).toEqual(['Line', 'Area', 'Bar', 'Heatmap']);
  const changed = await agent.act({ steps: [{ ref: 'Chart', action: 'setValue', args: ['Area'] }] });
  expect(changed.ok, changed.error?.message).toBe(true);
  await waitFor(() => expect(router.state.location.search).toMatchObject({ view: { chart: 'area' } }));
});

test('traces: filters by outcome, and a trace opens as a waterfall', async () => {
  const { router } = await renderConsole('/apps/atlas/traces', 'Traces');
  const labels = expectNamed(agent);
  for (const label of ['Kind', 'Outcome', 'At least', 'Only with spans']) expect(labels).toContain(label);
  const filtered = await agent.act({ steps: [{ ref: 'Outcome', action: 'setValue', args: ['Failed'] }] });
  expect(filtered.ok, filtered.error?.message).toBe(true);
  await waitFor(() => expect(router.state.location.search).toMatchObject({ f: { outcome: 'error' } }));

  const [first] = await screen.findAllByRole('link', { name: /\/api\// });
  await userEvent.click(first!);
  await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/apps\/atlas\/traces\/[0-9a-f]+$/));
  const waterfall = await screen.findByRole('treegrid');
  expect(within(waterfall).getAllByRole('row').length).toBeGreaterThan(1);
  expect(screen.getByRole('button', { name: 'Collapse all spans' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Expand all spans' })).toBeTruthy();
  expectNamed(agent);
});

test('alerts: a rule’s actions, the editor in a drawer, and deleting asks first', async () => {
  approve = false;
  await renderConsole('/apps/atlas/alerts?rule=a_jobs', 'Alerts');
  await screen.findByRole('button', { name: 'Delete Refresh jobs failing' });
  const labels = expectNamed(agent);
  for (const label of ['New rule', 'Pause', 'Edit', 'Delete Refresh jobs failing'])
    expect(labels).toContain(label);
  expect(screen.getByRole('link', { name: 'Requests failing' })).toBeTruthy();

  const opened = await agent.act({ steps: [{ ref: 'New rule', action: 'press' }] });
  expect(opened.ok, opened.error?.message).toBe(true);
  const drawer = await screen.findByRole('dialog');
  expect(within(drawer).getByLabelText('Threshold')).toBeTruthy();
  await userEvent.keyboard('{Escape}');

  await agent.act({ steps: [{ ref: 'Delete Refresh jobs failing', action: 'press' }] });
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog.textContent).toContain('Refresh jobs failing');
});
