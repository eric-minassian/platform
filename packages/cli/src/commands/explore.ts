import { readFileSync } from 'node:fs';
import {
  type Dashboard,
  type DashboardWidget,
  describeQuery,
  type QueryView,
  type SaveDashboardRequest,
  type SavedQuery,
} from '@ericminassian/platform-core';
import { type Command, Option } from 'commander';
import pc from 'picocolors';
import { CliError, EXIT, result, table } from '../util/output.ts';
import { shortTime } from '../util/time.ts';
import { action, apiFor, appFor, type CommonOpts, withCommon } from './common.ts';
import { readStdin } from './observe.ts';

/** `--app` only: saved queries belong to an app, not a stage. */
const withApp = (cmd: Command) =>
  withCommon(cmd.option('--app <name>', 'app name (default: from plat.config.ts)'));

export function registerExplore(program: Command): void {
  // ------------------------------------------------------------ saved queries
  const queries = program
    .command('queries')
    .description("an app's saved explorer, log and trace queries (saved in the console)");

  withApp(queries.command('list', { isDefault: true }).description('the app’s saved queries')).action(
    action(async (opts: CommonOpts) => {
      const list = await apiFor(opts).listQueries(await appFor(opts));
      result(list, formatQueries);
    }),
  );

  withApp(queries.command('show <id>').description('one saved query, with what it reads')).action(
    action(async (id: string, opts: CommonOpts) => {
      const app = await appFor(opts);
      const query = (await apiFor(opts).listQueries(app)).find((q) => q.id === id);
      if (!query)
        throw new CliError(`no saved query ${id} in ${app}`, {
          hint: 'see `plat queries list`',
          exitCode: EXIT.notFound,
        });
      result(query, formatQuery);
    }),
  );

  withApp(queries.command('delete <id>').description('delete a saved query')).action(
    action(async (id: string, opts: CommonOpts) => {
      await apiFor(opts).deleteQuery(await appFor(opts), id);
      result({ deleted: id }, () => `${pc.green('✓')} deleted saved query ${id}`);
    }),
  );

  // ------------------------------------------------------------ dashboards
  const dashboards = program
    .command('dashboards')
    .description('dashboards: an app’s, and those that span apps');

  withCommon(
    dashboards
      .command('list', { isDefault: true })
      .description('every dashboard you can see; with --app, that app’s and those that span apps')
      .option('--app <name>', 'only this app’s (and those that span apps)'),
  ).action(
    action(async (opts: CommonOpts) => {
      const list = await apiFor(opts).listDashboards(opts.app);
      result(list, formatDashboards);
    }),
  );

  withCommon(dashboards.command('show <id>').description('a dashboard and its widgets')).action(
    action(async (id: string, opts: CommonOpts) => {
      result(await apiFor(opts).getDashboard(id), formatDashboard);
    }),
  );

  withCommon(dashboards.command('delete <id>').description('delete a dashboard')).action(
    action(async (id: string, opts: CommonOpts) => {
      await apiFor(opts).deleteDashboard(id);
      result({ deleted: id }, () => `${pc.green('✓')} deleted dashboard ${id}`);
    }),
  );

  withCommon(
    dashboards
      .command('apply')
      .description(
        'create a dashboard from JSON, or replace the one its "id" names (`plat dashboards show <id> --json` is a starting point)',
      )
      .addOption(new Option('--file <path>', 'the dashboard as JSON, or - for stdin').makeOptionMandatory()),
  ).action(
    action(async (opts: CommonOpts & { file: string }) => {
      const { id, request } = dashboardInput(opts.file === '-' ? readStdin() : readFile(opts.file));
      const api = apiFor(opts);
      const saved = id ? await api.updateDashboard(id, request) : await api.createDashboard(request);
      result(saved, (d) => `${pc.green('✓')} ${id ? 'updated' : 'created'} dashboard ${d.id} (${d.name})`);
    }),
  );
}

function readFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new CliError(`can't read ${path}: ${(err as Error).message}`, { exitCode: EXIT.usage });
  }
}

/**
 * A dashboard to save from its JSON: the fields a save takes, and the `id`
 * of the one it replaces. What the API adds (`createdBy`, `updatedAt`…) is
 * left out, so `show --json` output can be edited and applied.
 */
export function dashboardInput(text: string): { id?: string; request: SaveDashboardRequest } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CliError(`the dashboard isn't JSON: ${(err as Error).message}`, { exitCode: EXIT.usage });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new CliError('the dashboard must be a JSON object with name and widgets', { exitCode: EXIT.usage });
  const d = parsed as Partial<Dashboard>;
  if (d.id !== undefined && typeof d.id !== 'string')
    throw new CliError('"id" must be a dashboard id', { exitCode: EXIT.usage });
  const request = {
    name: d.name,
    ...(d.app === undefined ? {} : { app: d.app }),
    ...(d.range === undefined ? {} : { range: d.range }),
    widgets: d.widgets ?? [],
  } as SaveDashboardRequest;
  return { ...(d.id ? { id: d.id } : {}), request };
}

/** What a view reads, in a line. */
export function describeView(view: QueryView): string {
  switch (view.kind) {
    case 'metrics':
      return view.queries
        .filter((q) => !q.hidden)
        .map((q) => q.label ?? describeQuery(q))
        .concat((view.expressions ?? []).filter((e) => !e.hidden).map((e) => e.label ?? e.expr))
        .join('; ');
    case 'logs': {
      if (view.insights) return `Logs Insights: ${view.insights.split('\n')[0]}`;
      const f = view.filters ?? {};
      const parts = [
        view.q ? `"${view.q}"` : undefined,
        f.levels?.length ? f.levels.join('+') : undefined,
        f.streams?.length ? f.streams.join('+') : undefined,
        f.routes?.length ? f.routes.join(', ') : undefined,
        f.status?.length ? f.status.join('+') : undefined,
        f.revs?.length ? `rev ${f.revs.join(', ')}` : undefined,
        f.trace ? `trace ${f.trace}` : undefined,
      ].filter(Boolean);
      return parts.length ? `logs: ${parts.join(' · ')}` : 'logs';
    }
    case 'traces': {
      const f = view.filters;
      const parts = [
        f.kind === 'req' ? 'requests' : f.kind === 'job' ? 'jobs' : undefined,
        ...(f.routes ?? []),
        ...(f.jobs ?? []),
        f.outcome === 'error' ? 'failed' : f.outcome === 'ok' ? 'ok' : undefined,
        f.minMs !== undefined ? `≥ ${f.minMs}ms` : undefined,
        f.recorded ? 'recorded' : undefined,
      ].filter(Boolean);
      return parts.length ? `traces: ${parts.join(' · ')}` : 'traces';
    }
    default:
      return '';
  }
}

export function formatQueries(list: readonly SavedQuery[]): string {
  if (list.length === 0) return pc.dim('(no saved queries)');
  return table(
    list.map((q) => ({
      id: q.id,
      name: q.name,
      reads: describeView(q.view).slice(0, 80),
      stage: q.stage ?? '',
      range: q.range ?? '',
      updated: shortTime(q.updatedAt),
      by: q.createdBy,
    })),
  );
}

export function formatQuery(q: SavedQuery): string {
  const rows: Array<[string, string]> = [
    ['id', q.id],
    ['reads', describeView(q.view)],
    ...(q.stage ? [['stage', q.stage] as [string, string]] : []),
    ...(q.range ? [['range', q.range] as [string, string]] : []),
    ['saved', `${shortTime(q.updatedAt)} (created by ${q.createdBy})`],
  ];
  return [
    pc.bold(q.name),
    ...rows.map(([k, v]) => `  ${k.padEnd(7)}${v}`),
    '',
    JSON.stringify(q.view, null, 2),
  ].join('\n');
}

export function formatDashboards(list: readonly Dashboard[]): string {
  if (list.length === 0) return pc.dim('(no dashboards)');
  return table(
    list.map((d) => ({
      id: d.id,
      name: d.name,
      app: d.app ?? pc.dim('(all apps)'),
      widgets: d.widgets.length,
      updated: shortTime(d.updatedAt),
      by: d.updatedBy,
    })),
  );
}

export function formatDashboard(d: Dashboard): string {
  const head = `${pc.bold(d.name)} ${pc.dim(`${d.id} · ${d.app ?? 'all apps'}${d.range ? ` · ${d.range}` : ''}`)}`;
  if (d.widgets.length === 0) return `${head}\n${pc.dim('(no widgets)')}`;
  const where = (w: DashboardWidget) => [w.app, w.stage].filter(Boolean).join('/');
  return [
    head,
    table(
      d.widgets.map((w) => ({
        widget: w.id,
        title: w.title,
        at: `${w.x},${w.y} ${w.w}×${w.h}`,
        reads: `${describeView(w.view)}${where(w) ? ` (${where(w)})` : ''}`.slice(0, 100),
      })),
    ),
  ].join('\n');
}
