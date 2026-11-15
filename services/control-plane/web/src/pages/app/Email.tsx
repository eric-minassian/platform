import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import type { EmailSending, EmailStatsResponse } from '@ericminassian/platform-core';
import { AsyncResult, Atom } from 'effect/reactivity';
import { ApiClient, failure, fresh, loadedPages, pages, timeToLive } from '../../client.ts';
import { Lines, SERIES_COLORS } from '../../components/charts.tsx';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Loaded,
  Mono,
  Spinner,
  Stat,
  Table,
  type Tone,
} from '../../components/ui.tsx';
import { fmtDateTime, fmtNum, fmtPct, relTime } from '../../format.ts';
import { type Scope, useApp } from '../AppLayout.tsx';

/** Reactivity keys of a stage's sending status and of its suppression list. */
const emailChanged = (app: string, stage: string) => [`email:${app}:${stage}`];
const suppressedChanged = (app: string, stage: string) => [`email-suppressed:${app}:${stage}`];

const statsAtom = Atom.family(({ app, stage, range }: Scope & { app: string }) =>
  fresh(
    ApiClient.query('observe', 'email', {
      params: { app },
      query: { stage, range },
      reactivityKeys: emailChanged(app, stage),
      timeToLive,
    }),
    { every: '60 seconds' },
  ),
);
const suppressedPages = Atom.family(({ app, stage }: { app: string; stage: string }) =>
  // Removing an address reloads the list from its first page.
  Atom.withReactivity(suppressedChanged(app, stage))(
    pages(
      (next) =>
        ApiClient.use((client) => client.manage.suppressed({ params: { app }, query: { stage, next } })),
      (page) => page.next,
    ),
  ),
);
const unsuppressAtom = ApiClient.mutation('manage', 'unsuppress');
const resumeAtom = ApiClient.mutation('manage', 'resumeEmail');

const PAUSED_BY: Record<NonNullable<EmailSending['pausedBy']>, string> = {
  policy: 'by the reputation policy',
  manual: 'manually',
  aws: 'by AWS',
};

const count = (n: number, one: string, many: string) => `${fmtNum(n)} ${n === 1 ? one : many}`;

/** SES reviews an account above the lower rate and may pause it above the higher one. */
const rateTone = (rate: number | null, review: number, pause: number): Tone =>
  rate === null ? 'muted' : rate >= pause ? 'bad' : rate >= review ? 'warn' : 'ok';

export function EmailTab() {
  const { app, scope } = useApp();
  const result = useAtomValue(statsAtom({ app, ...scope }));
  return (
    <Loaded result={result}>
      {(s) =>
        s.enabled ? (
          <EmailStage app={app} scope={scope} stats={s} />
        ) : (
          <Card>
            <Empty>No email declared in plat.config.ts.</Empty>
          </Card>
        )
      }
    </Loaded>
  );
}

function EmailStage({ app, scope, stats: s }: { app: string; scope: Scope; stats: EmailStatsResponse }) {
  const { sends, deliveries, bounces, complaints } = s.totals;
  const bounceRate = sends ? bounces / sends : null;
  const complaintRate = sends ? complaints / sends : null;
  const today = s.today;
  return (
    <div className="space-y-3">
      <div className="text-[12px] text-muted">
        Sends from <Mono className="text-fg">{s.from}</Mono>
      </div>
      {s.sending?.status === 'paused' && <Paused app={app} stage={scope.stage} sending={s.sending} />}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat
          label="Sending"
          value={!s.sending ? '—' : s.sending.status === 'paused' ? 'Paused' : 'Enabled'}
          tone={!s.sending ? 'muted' : s.sending.status === 'paused' ? 'bad' : 'ok'}
          hint={s.sending ? undefined : 'not deployed yet'}
        />
        <Stat
          label="Today"
          value={today ? `${fmtNum(today.sent)} / ${fmtNum(today.limit)}` : '—'}
          tone={
            !today
              ? 'muted'
              : today.sent >= today.limit
                ? 'bad'
                : today.sent >= today.limit * 0.8
                  ? 'warn'
                  : undefined
          }
          hint="recipients, UTC day"
        />
        <Stat label="Sent" value={fmtNum(sends)} hint={`${fmtNum(deliveries)} delivered · ${scope.range}`} />
        <Stat
          label="Bounce rate"
          value={fmtPct(bounceRate)}
          tone={rateTone(bounceRate, 0.05, 0.1)}
          hint={count(bounces, 'bounce', 'bounces')}
        />
        <Stat
          label="Complaint rate"
          value={fmtPct(complaintRate, 2)}
          tone={rateTone(complaintRate, 0.001, 0.005)}
          hint={count(complaints, 'complaint', 'complaints')}
        />
      </div>
      <Card title="Delivery">
        <Lines
          data={[...s.points]}
          range={scope.range}
          format={fmtNum}
          series={[
            { key: 'sends', label: 'sent', color: SERIES_COLORS.value },
            { key: 'deliveries', label: 'delivered', color: SERIES_COLORS.s2xx },
            { key: 'bounces', label: 'bounced', color: SERIES_COLORS.s4xx },
            { key: 'complaints', label: 'complaints', color: SERIES_COLORS.s5xx },
          ]}
        />
      </Card>
      {/* Without a tenant there's no list to read yet. */}
      {s.sending && <SuppressionList app={app} stage={scope.stage} />}
    </div>
  );
}

function Paused({ app, stage, sending }: { app: string; stage: string; sending: EmailSending }) {
  const [resume, resumeEmail] = useAtom(resumeAtom);
  const byAws = sending.pausedBy === 'aws';
  return (
    <div className="space-y-2 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-[12px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-0.5">
          <div className="font-medium text-bad">
            Sending paused {PAUSED_BY[sending.pausedBy ?? 'policy']}
            {sending.since && (
              <span className="font-normal text-muted" title={fmtDateTime(sending.since)}>
                {' '}
                · {relTime(sending.since)}
              </span>
            )}
          </div>
          {sending.cause && <div>{sending.cause}</div>}
          {byAws && (
            <div className="text-muted">
              Only AWS Support can lift this pause, through the case AWS opened in the Support Center.
            </div>
          )}
        </div>
        {!byAws && (
          <Button
            variant="primary"
            disabled={resume.waiting}
            onClick={() =>
              resumeEmail({ params: { app }, query: { stage }, reactivityKeys: emailChanged(app, stage) })
            }
          >
            Resume sending
          </Button>
        )}
      </div>
      <ErrorBox error={failure(resume)} />
    </div>
  );
}

function SuppressionList({ app, stage }: { app: string; stage: string }) {
  const atom = suppressedPages({ app, stage });
  const result = useAtomValue(atom);
  const loadMore = useAtomSet(atom);
  const [removal, unsuppress] = useAtom(unsuppressAtom);
  const loaded = loadedPages(result);
  const rows = loaded.flatMap((p) => p.items);
  return (
    <Card title="Suppression list">
      <ErrorBox error={failure(removal) ?? (result._tag === 'Failure' ? result.cause : undefined)} />
      {AsyncResult.isInitial(result) ? (
        <Spinner />
      ) : (
        <Table head={['Address', 'Reason', 'Since', '']} empty="No suppressed addresses.">
          {rows.map((r) => (
            <tr key={r.address}>
              <td>
                <Mono>{r.address}</Mono>
              </td>
              <td>
                <Badge tone={r.reason === 'complaint' ? 'bad' : 'warn'}>{r.reason}</Badge>
              </td>
              <td title={fmtDateTime(r.since)}>{relTime(r.since)}</td>
              <td className="text-right">
                <Button
                  disabled={removal.waiting}
                  onClick={() =>
                    unsuppress({
                      params: { app, address: r.address },
                      query: { stage },
                      reactivityKeys: suppressedChanged(app, stage),
                    })
                  }
                >
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {loaded.at(-1)?.next !== undefined && (
        <Button onClick={() => loadMore()} disabled={result.waiting}>
          Load more
        </Button>
      )}
    </Card>
  );
}
