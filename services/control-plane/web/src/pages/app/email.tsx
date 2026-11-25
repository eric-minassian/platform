/**
 * An app stage's transactional email: its sender, whether SES lets it send
 * (and resuming it after a pause by the reputation policy or by hand), how
 * much of today's recipient limit is used, sends, deliveries, bounces and
 * complaints over the page's window against the rates SES acts on, and the
 * stage's suppression list.
 */
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import type { EmailSending, EmailStatsResponse, SuppressedAddress } from '@ericminassian/platform-core';
import { AsyncResult, Atom } from 'effect/reactivity';
import { CirclePause } from 'lucide-react';
import { type ReactElement, useCallback, useMemo } from 'react';
import { ApiClient, fresh, loadedPages, pages, timeToLive } from '../../client.ts';
import { ConfirmAction } from '../../components/actions/confirm-action.tsx';
import { report } from '../../components/actions/report.ts';
import { columns, DataTable } from '../../components/data-table.tsx';
import {
  EmptyState,
  ErrorNotice,
  Loaded,
  Loading,
  Mono,
  PageHeader,
  Panel,
  Stat,
  Stats,
  StatusDot,
  StatusPill,
  type Tone,
} from '../../components/page.tsx';
import { type PointSeries, PointsChart } from '../../components/points/points-chart.tsx';
import { Button } from '../../components/ui/button.tsx';
import { family } from '../../data/atoms.ts';
import { fmtDateTime, fmtNum, fmtPct, relTime } from '../../format.ts';
import { useAutoRefresh, useStage, useSticky, useTime } from '../../lib/hooks.ts';
import { apiTime, type TimeSearch } from '../../lib/time.ts';
import { appRoute } from '../../router.tsx';

/** Reactivity keys of a stage's sending status and of its suppression list. */
const emailChanged = (app: string, stage: string) => [`email:${app}:${stage}`];
const suppressedChanged = (app: string, stage: string) => [`email-suppressed:${app}:${stage}`];

const statsAtom = family((k: { app: string; stage: string; time: TimeSearch }) =>
  fresh(
    ApiClient.query('observe', 'email', {
      params: { app: k.app },
      query: { stage: k.stage, ...apiTime(k.time) },
      reactivityKeys: emailChanged(k.app, k.stage),
      timeToLive,
    }),
    { every: '60 seconds' },
  ),
);
const suppressedPages = family((k: { app: string; stage: string }) =>
  // Removing an address reloads the list from its first page.
  Atom.withReactivity(suppressedChanged(k.app, k.stage))(
    pages(
      (next) =>
        ApiClient.use((client) =>
          client.manage.suppressed({ params: { app: k.app }, query: { stage: k.stage, next } }),
        ),
      (page) => page.next,
    ),
  ),
);
const unsuppressAtom = ApiClient.mutation('manage', 'unsuppress');
const resumeAtom = ApiClient.mutation('manage', 'resumeEmail');

const PAUSED_BY: Record<NonNullable<EmailSending['pausedBy']>, string> = {
  policy: 'by the reputation policy',
  manual: 'by hand',
  aws: 'by AWS',
};

const count = (n: number, one: string, many: string) => `${fmtNum(n)} ${n === 1 ? one : many}`;

/** SES reviews an account above the lower rate and may pause it above the higher one. */
const rateTone = (rate: number | null, review: number, pause: number): Tone | undefined =>
  rate === null ? undefined : rate >= pause ? 'bad' : rate >= review ? 'warn' : undefined;

const DELIVERY: readonly PointSeries<'sends' | 'deliveries' | 'bounces' | 'complaints'>[] = [
  { key: 'sends', label: 'Sent', color: 'var(--chart-1)' },
  { key: 'deliveries', label: 'Delivered', color: 'var(--chart-3)' },
  { key: 'bounces', label: 'Bounced', color: 'var(--s4xx)' },
  { key: 'complaints', label: 'Complaints', color: 'var(--s5xx)' },
];

export function EmailPage(): ReactElement {
  const { app } = appRoute.useParams();
  const stage = useStage();
  const time = useTime();
  const atom = statsAtom({ app, stage, time: time.search });
  useAutoRefresh(atom, time.search.from === undefined);
  const result = useSticky(useAtomValue(atom));
  return (
    <Loaded
      result={result}
      loading={
        <>
          <PageHeader title="Email" />
          <Loading />
        </>
      }
    >
      {(s) =>
        s.enabled ? (
          <EmailStage app={app} stage={stage} stats={s} />
        ) : (
          <div className="flex flex-col gap-5">
            <PageHeader title="Email" />
            <Panel>
              <EmptyState title={`No email on ${stage}`}>
                Declare <Mono>email</Mono> in <Mono>plat.config.ts</Mono> to send from this app.
              </EmptyState>
            </Panel>
          </div>
        )
      }
    </Loaded>
  );
}

function EmailStage({ app, stage, stats: s }: { app: string; stage: string; stats: EmailStatsResponse }) {
  const { sends, deliveries, bounces, complaints } = s.totals;
  const bounceRate = sends ? bounces / sends : null;
  const complaintRate = sends ? complaints / sends : null;
  const today = s.today;
  const paused = s.sending?.status === 'paused';
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Email"
        description={
          s.from ? (
            <>
              Sends from <Mono className="text-foreground">{s.from}</Mono>
            </>
          ) : undefined
        }
      />
      {s.sending && paused && <Paused app={app} stage={stage} sending={s.sending} />}
      <Stats>
        <Stat
          label="Sending"
          value={
            s.sending ? (
              <span className="flex items-center gap-2.5">
                <StatusDot tone={paused ? 'bad' : 'ok'} className="size-2.5" />
                {paused ? 'Paused' : 'Enabled'}
              </span>
            ) : (
              '–'
            )
          }
          tone={paused ? 'bad' : undefined}
          note={
            !s.sending
              ? 'not deployed yet'
              : paused && s.sending.since
                ? `since ${relTime(s.sending.since)}`
                : 'SES accepts its mail'
          }
        />
        <Stat
          label="Today"
          value={today ? `${fmtNum(today.sent)} of ${fmtNum(today.limit)}` : '–'}
          tone={
            !today
              ? undefined
              : today.sent >= today.limit
                ? 'bad'
                : today.sent >= today.limit * 0.8
                  ? 'warn'
                  : undefined
          }
          note="recipients this UTC day"
        />
        <Stat label="Sent" value={fmtNum(sends)} note={`${fmtNum(deliveries)} delivered`} />
        <Stat
          label="Bounce rate"
          value={fmtPct(bounceRate)}
          tone={rateTone(bounceRate, 0.05, 0.1)}
          note={`${count(bounces, 'bounce', 'bounces')}, review at 5%`}
        />
        <Stat
          label="Complaint rate"
          value={fmtPct(complaintRate, 2)}
          tone={rateTone(complaintRate, 0.001, 0.005)}
          note={`${count(complaints, 'complaint', 'complaints')}, review at 0.1%`}
        />
      </Stats>
      <Panel title="Delivery" description="What SES did with this stage's mail">
        <PointsChart
          points={s.points}
          res={s.res}
          series={DELIVERY}
          kind="line"
          format={fmtNum}
          ariaLabel="Emails sent, delivered, bounced and complained about"
        />
      </Panel>
      {/* Without a tenant there's no list to read yet. */}
      {s.sending && <SuppressionList app={app} stage={stage} />}
    </div>
  );
}

function Paused({ app, stage, sending }: { app: string; stage: string; sending: EmailSending }) {
  const [resume, resumeEmail] = useAtom(resumeAtom, { mode: 'promiseExit' });
  const byAws = sending.pausedBy === 'aws';
  return (
    <div
      role="alert"
      className="flex flex-wrap items-start gap-3 rounded-lg border border-bad-mark/30 bg-bad-mark/8 px-3.5 py-3 text-sm"
    >
      <CirclePause className="mt-0.5 size-4 shrink-0 text-bad" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="font-medium text-bad">
          Sending paused {PAUSED_BY[sending.pausedBy ?? 'policy']}
          {sending.since && (
            <span className="font-normal text-muted-foreground" title={fmtDateTime(sending.since)}>
              {' '}
              · {relTime(sending.since)}
            </span>
          )}
        </div>
        {sending.cause && <div>{sending.cause}</div>}
        {byAws && (
          <div className="text-muted-foreground">
            Only AWS Support can lift this pause, through the case AWS opened in the Support Center.
          </div>
        )}
      </div>
      {!byAws && (
        <Button
          size="sm"
          disabled={resume.waiting}
          onClick={() =>
            void report(
              resumeEmail({ params: { app }, query: { stage }, reactivityKeys: emailChanged(app, stage) }),
              `Sending resumed on ${stage}`,
            )
          }
        >
          Resume sending
        </Button>
      )}
    </div>
  );
}

function SuppressionList({ app, stage }: { app: string; stage: string }) {
  const atom = suppressedPages({ app, stage });
  const result = useAtomValue(atom);
  const loadMore = useAtomSet(atom);
  const [removal, unsuppress] = useAtom(unsuppressAtom, { mode: 'promiseExit' });
  const loaded = loadedPages(result);
  const rows = loaded.flatMap((p) => p.items);
  const more = loaded.at(-1)?.next !== undefined;
  const remove = useCallback(
    (address: string) =>
      report(
        unsuppress({
          params: { app, address },
          query: { stage },
          reactivityKeys: suppressedChanged(app, stage),
        }),
        `${address} can receive mail from ${stage} again`,
      ),
    [app, stage, unsuppress],
  );
  const tableColumns = useMemo(
    () => suppressedColumns(stage, removal.waiting, remove),
    [stage, removal.waiting, remove],
  );
  return (
    <Panel
      flush
      title="Suppression list"
      description="Addresses SES no longer sends to from this stage, after a bounce or a complaint"
    >
      {result._tag === 'Failure' && <ErrorNotice error={result.cause} className="mx-5 mb-3" />}
      {AsyncResult.isInitial(result) ? (
        <Loading rows={3} />
      ) : (
        <DataTable
          columns={tableColumns}
          data={rows}
          getRowId={(r) => r.address}
          empty={<EmptyState title="No suppressed addresses" />}
        />
      )}
      {more && (
        <div className="border-t px-5 py-2.5">
          <Button variant="outline" size="sm" onClick={() => loadMore()} disabled={result.waiting}>
            {result.waiting ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </Panel>
  );
}

const suppressed = columns<SuppressedAddress>();
function suppressedColumns(stage: string, busy: boolean, remove: (address: string) => Promise<boolean>) {
  return suppressed.columns([
    suppressed.accessor('address', { header: 'Address', cell: ({ getValue }) => <Mono>{getValue()}</Mono> }),
    suppressed.accessor('reason', {
      header: 'Reason',
      cell: ({ getValue }) => (
        <StatusPill tone={getValue() === 'complaint' ? 'bad' : 'warn'}>
          {getValue() === 'complaint' ? 'Complaint' : 'Bounce'}
        </StatusPill>
      ),
    }),
    suppressed.accessor('since', {
      header: 'Since',
      cell: ({ getValue }) => <span title={fmtDateTime(getValue())}>{relTime(getValue())}</span>,
    }),
    suppressed.display({
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: 'w-0 text-right' },
      cell: ({ row }) => {
        const { address } = row.original;
        return (
          <ConfirmAction
            trigger={<Button variant="outline" size="xs" aria-label={`Remove ${address}`} />}
            disabled={busy}
            title={`Remove ${address}?`}
            description={`SES sends mail from ${stage} to this address again.`}
            confirmLabel="Remove address"
            onConfirm={() => remove(address)}
          >
            Remove
          </ConfirmAction>
        );
      },
    }),
  ]);
}
