import {
  type EmailSending,
  type EmailStatsResponse,
  PROD_STAGE,
  type SuppressedResponse,
} from '@ericminassian/platform-core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { result, sparkline, table } from '../util/output.ts';
import { shortTime, sinceRange } from '../util/time.ts';
import { action, apiFor, appFor, type CommonOpts, withTarget } from './common.ts';

type TargetOpts = CommonOpts & { stage: string };

export function registerEmail(program: Command): void {
  const email = program
    .command('email')
    .description("a stage's email: sending status, suppression list, resuming after a pause");

  // The default subcommand, so `plat email --stage pr-3` reaches it; options on
  // `email` itself would swallow the same options given to its subcommands.
  withTarget(
    email
      .command('status', { isDefault: true })
      .description("sender, sending status, today's recipients and delivery counts")
      .option('--since <duration>', 'time range', '7d'),
  ).action(
    action(async (opts: TargetOpts & { since: string }) => {
      const stats = await apiFor(opts).email(await appFor(opts), {
        stage: opts.stage,
        ...sinceRange(opts.since),
      });
      result(stats, (s) => formatEmailStats(s, opts.since));
    }),
  );

  withTarget(
    email
      .command('suppressed')
      .description("addresses SES won't send to from this stage (they bounced or complained)")
      .option('--next <token>', 'continue from a previous page'),
  ).action(
    action(async (opts: TargetOpts & { next?: string }) => {
      const page = await apiFor(opts).suppressed(await appFor(opts), {
        stage: opts.stage,
        ...(opts.next ? { next: opts.next } : {}),
      });
      result(page, (p) => formatSuppressed(p, opts.stage));
    }),
  );

  withTarget(email.command('unsuppress <address>').description('let SES send to an address again')).action(
    action(async (address: string, opts: TargetOpts) => {
      await apiFor(opts).unsuppress(await appFor(opts), address, { stage: opts.stage });
      result(
        { address, stage: opts.stage, unsuppressed: true },
        () => `${pc.green('✓')} removed ${address} from ${opts.stage}'s suppression list`,
      );
    }),
  );

  withTarget(email.command('resume').description('resume sending after SES paused it')).action(
    action(async (opts: TargetOpts) => {
      const sending = await apiFor(opts).resumeEmail(await appFor(opts), { stage: opts.stage });
      result(sending, (s) =>
        s.status === 'enabled'
          ? `${pc.green('✓')} ${opts.stage} can send email`
          : formatSending(s, opts.stage).join('\n'),
      );
    }),
  );
}

const PAUSED_BY: Record<NonNullable<EmailSending['pausedBy']>, string> = {
  policy: 'by the reputation policy',
  manual: 'manually',
  aws: 'by AWS',
};

/** The sending status lines: the status, then SES's cause and what to do about it. */
export function formatSending(s: EmailSending, stage: string): string[] {
  if (s.status === 'enabled') return [pc.green('enabled')];
  const resume = `plat email resume${stage === PROD_STAGE ? '' : ` --stage ${stage}`}`;
  return [
    `${pc.red('PAUSED')} ${PAUSED_BY[s.pausedBy ?? 'policy']}${s.since ? ` since ${shortTime(s.since)}` : ''}`,
    ...(s.cause ? [s.cause] : []),
    pc.dim(
      s.pausedBy === 'aws'
        ? 'only AWS Support can lift this pause, through the case AWS opened in the Support Center'
        : `run \`${resume}\` once the cause is fixed`,
    ),
  ];
}

export function formatEmailStats(s: EmailStatsResponse, since: string): string {
  if (!s.enabled) return pc.dim(`(no email on ${s.stage}; set email: true in plat.config.ts and deploy)`);
  const { sends, deliveries, bounces, complaints } = s.totals;
  const pct = (n: number, digits: number) => (sends ? `${((n / sends) * 100).toFixed(digits)}%` : '-');
  const [status, ...detail] = s.sending ? formatSending(s.sending, s.stage) : [pc.dim('not deployed yet')];
  const row = (label: string, value: number, values: number[]) =>
    `  ${label.padEnd(11)}${String(value).padStart(8)}  ${sparkline(values)}`;
  return [
    `${pc.bold(s.app)} ${pc.dim(`${s.stage} · last ${since} · ${s.res} buckets`)}`,
    '',
    `  from       ${s.from ?? '-'}`,
    `  sending    ${status}`,
    ...detail.map((line) => `             ${line}`),
    `  today      ${s.today ? `${s.today.sent} / ${s.today.limit} recipients (UTC day)` : '-'}`,
    '',
    row(
      'sent',
      sends,
      s.points.map((p) => p.sends),
    ),
    row(
      'delivered',
      deliveries,
      s.points.map((p) => p.deliveries),
    ),
    row(
      'bounced',
      bounces,
      s.points.map((p) => p.bounces),
    ),
    row(
      'complaints',
      complaints,
      s.points.map((p) => p.complaints),
    ),
    '',
    `  bounce rate ${pct(bounces, 1)} · complaint rate ${pct(complaints, 2)}`,
  ].join('\n');
}

export function formatSuppressed(p: SuppressedResponse, stage: string): string {
  const rows = p.items.length
    ? table(p.items.map((i) => ({ address: i.address, reason: i.reason, since: shortTime(i.since) })))
    : pc.dim(`(no suppressed addresses on ${stage})`);
  return p.next ? `${rows}\n${pc.dim(`more: --next ${p.next}`)}` : rows;
}
