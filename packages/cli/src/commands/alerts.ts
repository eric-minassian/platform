import { readFileSync } from 'node:fs';
import {
  ALERT_WINDOWS,
  type AlertCondition,
  type AlertEvent,
  AlertMissingData,
  type AlertRule,
  type AlertRuleInput,
  type AlertState,
  describeQuery,
  PROD_STAGE,
  seriesUnit,
} from '@ericminassian/platform-core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { CliError, EXIT, result, table } from '../util/output.ts';
import { shortTime, sinceRange } from '../util/time.ts';
import { action, apiFor, appFor, type CommonOpts, withTarget } from './common.ts';
import { formatSeriesValue, readStdin, type SeriesFlags, seriesQueryOf } from './observe.ts';

/** The flags that make a rule's settings (`AlertRuleInput`). */
export interface AlertFlags extends Omit<SeriesFlags, 'by'> {
  name?: string;
  stage?: string;
  op?: string;
  threshold?: string;
  minutes?: string;
  missing?: string;
  notify?: boolean;
  enable?: boolean;
  disable?: boolean;
}

const usage = (message: string) => new CliError(message, { exitCode: EXIT.usage });

/**
 * A rule's settings from flags over `base` (pure): a `--file`'s, or the rule
 * being changed. What neither gives defaults to prod, `--missing ok`, and a
 * rule that notifies and is enabled; name, metric and condition must be given.
 */
export function alertRuleInputOf(flags: AlertFlags, base: Partial<AlertRuleInput> = {}): AlertRuleInput {
  if (flags.enable && flags.disable) throw usage('--enable and --disable contradict each other');
  const missing = [
    !(flags.name ?? base.name) && '--name',
    !(flags.metric ?? base.query?.metric) && '--metric',
    !(flags.op ?? base.condition?.op) && '--op',
    flags.threshold === undefined && base.condition?.threshold === undefined && '--threshold',
    !(flags.minutes ?? base.condition?.minutes) && '--minutes',
  ].filter((f): f is string => typeof f === 'string');
  if (missing.length) throw usage(`a rule needs ${missing.join(', ')}`);
  const queryFlags = flags.metric !== undefined || flags.stat !== undefined || Boolean(flags.filter?.length);
  const query =
    queryFlags || !base.query
      ? seriesQueryOf(flags, { alert: true, ...(base.query ? { base: base.query } : {}) })
      : base.query;
  const threshold = flags.threshold === undefined ? base.condition!.threshold : Number(flags.threshold);
  if (!Number.isFinite(threshold)) throw usage(`--threshold is a number, not "${flags.threshold}"`);
  const minutes = flags.minutes === undefined ? base.condition!.minutes : Number(flags.minutes);
  const window = ALERT_WINDOWS.find((w) => w === minutes);
  if (window === undefined) throw usage(`--minutes is one of ${ALERT_WINDOWS.join(', ')}`);
  const op = flags.op ?? base.condition!.op;
  if (op !== 'above' && op !== 'below') throw usage(`--op is above or below, not "${op}"`);
  const missingData = flags.missing ?? base.missing ?? 'ok';
  const missingOk = AlertMissingData.literals.find((m) => m === missingData);
  if (!missingOk) throw usage(`--missing is one of ${AlertMissingData.literals.join(', ')}`);
  const condition: AlertCondition = { op, threshold, minutes: window };
  return {
    name: (flags.name ?? base.name)!,
    stage: flags.stage ?? base.stage ?? PROD_STAGE,
    query,
    condition,
    missing: missingOk,
    notify: flags.notify ?? base.notify ?? true,
    enabled: flags.enable ? true : flags.disable ? false : (base.enabled ?? true),
  };
}

/** A `--file` (a path, or `-` for stdin): a rule's settings as JSON. */
function readRuleFile(path: string): Partial<AlertRuleInput> {
  let text: string;
  try {
    text = path === '-' ? readStdin() : readFileSync(path, 'utf8');
  } catch (err) {
    throw usage(`can't read ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usage(`${path === '-' ? 'stdin' : path} is not JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw usage('--file holds one rule: an object like `plat alerts list --json` shows');
  return parsed;
}

/** What a rule watches: `5xx % of requests above 2 over 5 min`. */
export function describeRule(rule: Pick<AlertRuleInput, 'query' | 'condition'>): string {
  const { op, threshold, minutes } = rule.condition;
  return `${describeQuery(rule.query)} ${op} ${formatSeriesValue(threshold, seriesUnit(rule.query))} over ${minutes} min`;
}

const STATE_COLOR: Record<AlertState, (s: string) => string> = {
  alarm: pc.red,
  ok: pc.green,
  no_data: pc.dim,
};

/** `plat alerts list`: each rule with its state and last value. */
export function formatAlertRules(rules: readonly AlertRule[]): string {
  if (rules.length === 0) return pc.dim('(no alert rules; add one with `plat alerts create`)');
  return table(
    rules.map((r) => ({
      id: r.id,
      name: r.name,
      stage: r.stage,
      state: r.enabled ? STATE_COLOR[r.state](r.state) : pc.dim('off'),
      watches: describeRule(r),
      value: r.value === undefined ? '-' : formatSeriesValue(r.value, seriesUnit(r.query)),
      since: r.stateSince ? shortTime(r.stateSince) : '',
      notify: r.notify ? 'yes' : 'no',
    })),
  );
}

/** `plat alerts history`: state changes, newest first. */
export function formatAlertHistory(events: readonly AlertEvent[]): string {
  if (events.length === 0) return pc.dim('(no state changes in this range)');
  return table(
    events.map((e) => ({
      at: shortTime(e.ts),
      stage: e.stage,
      rule: e.name,
      change: `${e.from} → ${STATE_COLOR[e.to](e.to)}`,
      value: e.value === null ? 'no data' : formatSeriesValue(e.value, 'count'),
      threshold: formatSeriesValue(e.threshold, 'count'),
    })),
  );
}

/** The settings flags `create` and `update` share. */
function withRuleFlags(cmd: Command): Command {
  return cmd
    .option('--file <path>', 'the rule as JSON (`-` for stdin); flags given as well override it')
    .option('--name <name>', 'what the rule is called')
    .option('--metric <metric>', 'what it watches (not realtime or service)')
    .option('--stat <stat>', "how the window is summarized (default: the metric's own, e.g. count or p95)")
    .option(
      '--filter <key=value>',
      'route, status, job, name (repeatable) or outcome',
      (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
    )
    .option('--op <op>', 'above or below')
    .option('--threshold <n>', 'the value it fires past')
    .option('--minutes <n>', `the window: ${ALERT_WINDOWS.join(', ')}`)
    .option('--missing <state>', 'a window without data counts as ok, alarm, or keep (the current state)')
    .option('--notify', 'email the alerts topic when it fires and recovers (the default)')
    .option('--no-notify', "don't email")
    .option('--disable', 'stop evaluating it');
}

type RuleOpts = CommonOpts & AlertFlags & { file?: string };

export function registerAlerts(program: Command): void {
  const alerts = program
    .command('alerts')
    .description("alert rules on an app's stages: state, history, and changing them");

  withTarget(
    alerts
      .command('list', { isDefault: true })
      .description("every stage's rules (or --stage's) and their state"),
    false,
  ).action(
    action(async (opts: CommonOpts & { stage?: string }) => {
      const rules = await apiFor(opts).alertRules(
        await appFor(opts),
        opts.stage ? { stage: opts.stage } : {},
      );
      result(rules, formatAlertRules);
    }),
  );

  withTarget(
    withRuleFlags(alerts.command('create').description('add a rule (on prod unless --stage says otherwise)')),
    false,
  ).action(
    action(async (opts: RuleOpts) => {
      const input = alertRuleInputOf(opts, opts.file ? readRuleFile(opts.file) : {});
      const rule = await apiFor(opts).createAlertRule(await appFor(opts), input);
      result(rule, (r) => `${pc.green('✓')} created ${r.id} on ${r.stage}: ${r.name} (${describeRule(r)})`);
    }),
  );

  withTarget(
    withRuleFlags(
      alerts
        .command('update <id>')
        .description('change a rule; a new stage, query or condition starts it over without data'),
    ).option('--enable', 'evaluate it again'),
    false,
  ).action(
    action(async (id: string, opts: RuleOpts) => {
      const api = apiFor(opts);
      const app = await appFor(opts);
      const current = (await api.alertRules(app)).find((r) => r.id === id);
      if (!current)
        throw new CliError(`no alert rule ${id} on ${app}`, {
          hint: 'see `plat alerts list`',
          exitCode: EXIT.notFound,
        });
      const input = alertRuleInputOf(opts, opts.file ? readRuleFile(opts.file) : current);
      const rule = await api.updateAlertRule(app, id, input);
      result(rule, (r) => `${pc.green('✓')} updated ${r.id}: ${r.name} (${describeRule(r)}), ${r.state}`);
    }),
  );

  withTarget(alerts.command('delete <id>').description('remove a rule'), false).action(
    action(async (id: string, opts: CommonOpts) => {
      await apiFor(opts).deleteAlertRule(await appFor(opts), id);
      result({ deleted: id }, () => `${pc.green('✓')} deleted ${id}`);
    }),
  );

  withTarget(
    alerts
      .command('history')
      .description("rules' state changes, newest first")
      .option('--since <duration>', 'how far back', '7d'),
    false,
  ).action(
    action(async (opts: CommonOpts & { stage?: string; since: string }) => {
      const { from, to } = sinceRange(opts.since);
      const r = await apiFor(opts).alertHistory(await appFor(opts), {
        ...(opts.stage ? { stage: opts.stage } : {}),
        from,
        to,
      });
      result(r, (v) => formatAlertHistory(v.events));
    }),
  );
}
