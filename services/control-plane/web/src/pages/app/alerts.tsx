/**
 * Alert rules on the stage: what each watches, its state, the metric with
 * its threshold over the page's window, and every state change. A rule is
 * evaluated each minute over its window; firing and recovering email the
 * platform's alerts address when `notify` is on.
 */
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import {
  ALERT_METRICS,
  ALERT_WINDOWS,
  type AlertCondition,
  type AlertMissingData,
  type AlertRule,
  type AlertRuleInput,
  breaches,
  checkSeriesQuery,
  describeQuery,
  type MetricsView,
  type NamedSeriesQuery,
  type QueryResolution,
  type SeriesQuery,
  seriesUnit,
} from '@ericminassian/platform-core';
import { Link, useNavigate } from '@tanstack/react-router';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { Bell, BellOff, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { ConfirmAction } from '../../components/actions/confirm-action.tsx';
import { report } from '../../components/actions/report.ts';
import { columns, DataTable } from '../../components/data-table.tsx';
import { MetricView } from '../../components/metrics/metric-view.tsx';
import { QueryRow } from '../../components/metrics/query-editor.tsx';
import { EmptyState, Loaded, PageHeader, Panel, StatusText, type Tone } from '../../components/page.tsx';
import { Button } from '../../components/ui/button.tsx';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '../../components/ui/drawer.tsx';
import { Field, FieldDescription, FieldLabel, FieldSet, FieldLegend } from '../../components/ui/field.tsx';
import { Input } from '../../components/ui/input.tsx';
import { NumberInput } from '../../components/ui/number-input.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.tsx';
import { Switch } from '../../components/ui/switch.tsx';
import { alertRulesAtom, alertsChanged, appChanged, family, seriesAtom } from '../../data/atoms.ts';
import { relTime } from '../../format.ts';
import { useStage, useTime } from '../../lib/hooks.ts';
import { usePrefs } from '../../lib/prefs.tsx';
import { formatterFor } from '../../lib/series.ts';
import { apiTime, timeFormat, type TimeSearch } from '../../lib/time.ts';
import { plainQuery } from '../../lib/view.ts';
import { alertsRoute } from '../../router.tsx';

const createRule = ApiClient.mutation('alerts', 'create');
const updateRule = ApiClient.mutation('alerts', 'update');
const removeRule = ApiClient.mutation('alerts', 'remove');

const historyAtom = family((k: { app: string; stage: string; time: TimeSearch }) =>
  fresh(
    ApiClient.query('alerts', 'history', {
      params: { app: k.app },
      query: { stage: k.stage, ...apiTime(k.time) },
      reactivityKeys: alertsChanged(k.app),
      timeToLive,
    }),
    { every: '60 seconds' },
  ),
);

const STATE: Record<AlertRule['state'], { tone: Tone; label: string }> = {
  alarm: { tone: 'bad', label: 'Firing' },
  ok: { tone: 'ok', label: 'OK' },
  no_data: { tone: 'muted', label: 'No data' },
};

const CHANGE: Record<AlertRule['state'], string> = { alarm: 'Fired', ok: 'Recovered', no_data: 'No data' };

/** A window of this many minutes as the bucket size that draws it. */
const WINDOW_RES: Record<(typeof ALERT_WINDOWS)[number], QueryResolution> = {
  1: '1m',
  5: '5m',
  10: '10m',
  15: '15m',
  30: '30m',
  60: '1h',
};

const windowLabel = (m: number) => (m === 60 ? '1 hour' : `${m} ${m === 1 ? 'minute' : 'minutes'}`);

const changedKeys = (app: string) => [...alertsChanged(app), ...appChanged(app)];

/** `above 2% over 5 minutes`. */
export function describeCondition(rule: { query: SeriesQuery; condition: AlertCondition }): string {
  const f = formatterFor(seriesUnit(rule.query));
  const c = rule.condition;
  return `${c.op} ${f(c.threshold)} over ${c.minutes === 60 ? 'an hour' : windowLabel(c.minutes)}`;
}

const valueOf = (r: AlertRule) =>
  r.value === null || r.value === undefined ? '–' : formatterFor(seriesUnit(r.query))(r.value);

const col = columns<AlertRule>();
/** The rules table's columns; a rule's name opens it beside the list. */
const ruleColumns = (app: string) =>
  col.columns([
    col.accessor((r) => (!r.enabled ? 3 : r.state === 'alarm' ? 0 : r.state === 'no_data' ? 1 : 2), {
      id: 'state',
      header: 'State',
      cell: ({ row }) => {
        const r = row.original;
        return r.enabled ? (
          <StatusText tone={STATE[r.state].tone}>{STATE[r.state].label}</StatusText>
        ) : (
          <StatusText tone="muted" className="text-muted-foreground">
            Paused
          </StatusText>
        );
      },
    }),
    col.accessor('name', {
      header: 'Rule',
      cell: ({ row }) => (
        <div className="max-w-[40rem] min-w-0">
          <Link
            to="/apps/$app/alerts"
            params={{ app }}
            search={(prev) => ({ ...prev, rule: row.original.id })}
            replace
            onClick={(e) => e.stopPropagation()}
            className="block truncate rounded-sm font-medium outline-hidden hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
          >
            {row.original.name}
          </Link>
          <div className="truncate text-[13px] text-muted-foreground">
            {describeQuery(row.original.query)} {describeCondition(row.original)}
          </div>
        </div>
      ),
    }),
    col.accessor((r) => r.value ?? -1, {
      id: 'value',
      header: 'Now',
      meta: { numeric: true },
      cell: ({ row }) => valueOf(row.original),
    }),
    col.accessor((r) => r.stateSince ?? '', {
      id: 'since',
      header: 'Since',
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-muted-foreground">{relTime(row.original.stateSince)}</span>
      ),
    }),
    col.accessor('notify', {
      header: 'Email',
      cell: ({ getValue }) =>
        getValue() ? (
          <span className="inline-flex text-muted-foreground">
            <Bell aria-hidden className="size-4" />
            <span className="sr-only">Emails when it fires and recovers</span>
          </span>
        ) : (
          <span className="inline-flex text-subtle">
            <BellOff aria-hidden className="size-4" />
            <span className="sr-only">No email</span>
          </span>
        ),
    }),
  ]);

export function AlertsPage() {
  const { app } = alertsRoute.useParams();
  const search = alertsRoute.useSearch();
  const navigate = useNavigate({ from: alertsRoute.fullPath });
  const stage = useStage();
  const time = useTime();
  const result = useAtomValue(alertRulesAtom({ app }));
  const all = Option.getOrElse(AsyncResult.value(result), (): readonly AlertRule[] => []);
  const rules = all.filter((r) => r.stage === stage);
  const elsewhere = all.length - rules.length;
  const selected =
    rules.find((r) => r.id === search.rule) ??
    rules.toSorted((a, b) => (a.state === 'alarm' ? -1 : b.state === 'alarm' ? 1 : 0))[0];
  const [editing, setEditing] = useState<AlertRule | 'new' | null>(search.draft ? 'new' : null);
  const close = () => {
    setEditing(null);
    if (search.draft) void navigate({ search: (prev) => ({ ...prev, draft: undefined }), replace: true });
  };

  return (
    <>
      <PageHeader
        title="Alerts"
        description={`Rules are checked every minute on ${stage}${elsewhere ? `; ${elsewhere} more on other stages` : ''}.`}
        actions={
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus />
            New rule
          </Button>
        }
      />
      <Loaded result={result} loading={<div className="h-48" />}>
        {() =>
          rules.length === 0 ? (
            <Panel>
              <EmptyState
                icon={<Bell />}
                title={`No alert rules on ${stage}`}
                action={
                  <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
                    <Plus />
                    New rule
                  </Button>
                }
              >
                A rule watches one metric, such as the share of 5xx responses or a route's p95, and emails
                when it crosses a threshold for a window of minutes. Charts' menus start one too.
              </EmptyState>
            </Panel>
          ) : (
            <Panel flush>
              <DataTable
                columns={ruleColumns(app)}
                data={rules}
                getRowId={(r) => r.id}
                initialSorting={[{ id: 'state', desc: false }]}
                isSelected={(r) => r.id === selected?.id}
                onRowClick={(r) =>
                  void navigate({ search: (prev) => ({ ...prev, rule: r.id }), replace: true })
                }
              />
            </Panel>
          )
        }
      </Loaded>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {selected && (
          <RuleDetail
            key={selected.id}
            app={app}
            stage={stage}
            rule={selected}
            time={time.search}
            onEdit={() => setEditing(selected)}
          />
        )}
        <History app={app} stage={stage} time={time.search} rules={all} />
      </div>
      <RuleDrawer
        app={app}
        stage={stage}
        editing={editing}
        draft={search.draft}
        onClose={close}
        onSaved={(r) =>
          void navigate({ search: (prev) => ({ ...prev, rule: r.id, draft: undefined }), replace: true })
        }
      />
    </>
  );
}

function RuleDetail({
  app,
  stage,
  rule,
  time,
  onEdit,
}: {
  app: string;
  stage: string;
  rule: AlertRule;
  time: TimeSearch;
  onEdit: () => void;
}) {
  const update = useAtomSet(updateRule, { mode: 'promiseExit' });
  const remove = useAtomSet(removeRule, { mode: 'promiseExit' });
  const view: MetricsView = {
    kind: 'metrics',
    queries: [{ id: 'a', ...rule.query, label: describeQuery(rule.query) }],
    chart: 'line',
    threshold: rule.condition.threshold,
  };
  const setEnabled = (enabled: boolean) =>
    void report(
      update({
        params: { app, id: rule.id },
        payload: { ...inputOf(rule), enabled },
        reactivityKeys: changedKeys(app),
      }),
      enabled ? `Resumed ${rule.name}` : `Paused ${rule.name}`,
    );
  return (
    <Panel
      title={rule.name}
      description={`${describeQuery(rule.query)} ${describeCondition(rule)}`}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={() => setEnabled(!rule.enabled)}>
            {rule.enabled ? <Pause /> : <Play />}
            {rule.enabled ? 'Pause' : 'Resume'}
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Pencil />
            Edit
          </Button>
          <ConfirmAction
            trigger={<Button variant="ghost" size="icon-sm" aria-label={`Delete ${rule.name}`} />}
            title={`Delete ${rule.name}?`}
            description="The rule stops being checked; its history stays for 90 days."
            confirmLabel="Delete rule"
            onConfirm={() =>
              report(
                remove({ params: { app, id: rule.id }, reactivityKeys: changedKeys(app) }),
                `Deleted ${rule.name}`,
              )
            }
          >
            <Trash2 />
          </ConfirmAction>
        </>
      }
      footer={
        <span>
          {rule.evaluatedAt ? `Checked ${relTime(rule.evaluatedAt)}. ` : ''}Each point is one{' '}
          {rule.condition.minutes === 60 ? 'hour' : `${rule.condition.minutes}-minute`} window; the dashed
          line is the threshold. With no data the rule{' '}
          {rule.missing === 'keep'
            ? 'keeps its state'
            : rule.missing === 'ok'
              ? 'counts as OK'
              : 'counts as firing'}
          .
        </span>
      }
    >
      <MetricView
        view={view}
        app={app}
        stage={stage}
        time={time}
        height={220}
        legend={false}
        res={WINDOW_RES[rule.condition.minutes]}
      />
    </Panel>
  );
}

function History({
  app,
  stage,
  time,
  rules,
}: {
  app: string;
  stage: string;
  time: TimeSearch;
  rules: readonly AlertRule[];
}) {
  const { utc } = usePrefs();
  const result = useAtomValue(historyAtom({ app, stage, time }));
  const when = timeFormat(utc, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return (
    <Panel flush title="History" description="State changes in the window, newest first">
      <Loaded result={result} loading={<div className="h-24" />}>
        {({ events }) =>
          events.length === 0 ? (
            <EmptyState title="No state changes in this window" />
          ) : (
            <ul>
              {events.map((e) => {
                const rule = rules.find((r) => r.id === e.rule);
                const f = rule ? formatterFor(seriesUnit(rule.query)) : (v: number) => String(v);
                return (
                  <li
                    key={`${e.rule}:${e.ts}`}
                    className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b px-5 py-2.5 text-sm last:border-0"
                  >
                    <StatusText tone={STATE[e.to].tone}>{CHANGE[e.to]}</StatusText>
                    <span className="min-w-0">
                      <span className="block truncate">{e.name}</span>
                      <span className="block truncate text-[13px] text-muted-foreground tabular">
                        {e.value === null ? 'No data' : `${f(e.value)} against ${f(e.threshold)}`}
                      </span>
                    </span>
                    <span className="text-[13px] whitespace-nowrap text-muted-foreground tabular">
                      {when(e.ts)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )
        }
      </Loaded>
    </Panel>
  );
}

const inputOf = (r: AlertRule): AlertRuleInput => ({
  name: r.name,
  stage: r.stage,
  query: r.query,
  condition: r.condition,
  missing: r.missing,
  notify: r.notify,
  enabled: r.enabled,
});

const DEFAULT_QUERY: SeriesQuery = { metric: 'requests', stat: 'percent', filter: { status: ['5xx'] } };

const OPS: ReadonlyArray<{ value: AlertCondition['op']; label: string }> = [
  { value: 'above', label: 'Above' },
  { value: 'below', label: 'Below' },
];

const WINDOWS = ALERT_WINDOWS.map((m) => ({ value: String(m), label: windowLabel(m) }));

const MISSING: Record<AlertMissingData, string> = {
  ok: 'Treat it as OK',
  alarm: 'Treat it as firing',
  keep: 'Keep the current state',
};
const MISSING_ITEMS = (Object.keys(MISSING) as AlertMissingData[]).map((m) => ({
  value: m,
  label: MISSING[m],
}));

/** What a threshold is in, and how finely it steps. */
function thresholdUnit(query: SeriesQuery): { hint: string; step: number; min?: number; max?: number } {
  switch (seriesUnit(query)) {
    case 'percent':
      return { hint: 'Percent, 0 to 100', step: 0.1, min: 0, max: 100 };
    case 'ms':
      return { hint: 'Milliseconds', step: 1, min: 0 };
    case 'per_second':
      return { hint: 'Per second', step: 0.01, min: 0 };
    default:
      return query.metric === 'custom'
        ? { hint: 'In the metric’s own unit', step: 0.01 }
        : { hint: 'Count', step: 1, min: 0 };
  }
}

function RuleDrawer({
  app,
  stage,
  editing,
  draft,
  onClose,
  onSaved,
}: {
  app: string;
  stage: string;
  editing: AlertRule | 'new' | null;
  draft: SeriesQuery | undefined;
  onClose: () => void;
  onSaved: (rule: AlertRule) => void;
}) {
  return (
    <Drawer open={editing !== null} onOpenChange={(open) => !open && onClose()}>
      <DrawerContent width="42rem" closeLabel="Close the rule editor">
        {editing !== null && (
          <RuleForm
            key={editing === 'new' ? 'new' : editing.id}
            app={app}
            stage={stage}
            rule={editing === 'new' ? undefined : editing}
            draft={draft}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </DrawerContent>
    </Drawer>
  );
}

function RuleForm({
  app,
  stage,
  rule,
  draft,
  onClose,
  onSaved,
}: {
  app: string;
  stage: string;
  rule: AlertRule | undefined;
  draft: SeriesQuery | undefined;
  onClose: () => void;
  onSaved: (rule: AlertRule) => void;
}) {
  const start = rule?.query ?? draft ?? DEFAULT_QUERY;
  const [name, setName] = useState(rule?.name ?? '');
  const [query, setQuery] = useState<NamedSeriesQuery>({ id: 'a', ...plainQuery({ id: 'a', ...start }) });
  const [op, setOp] = useState<AlertCondition['op']>(rule?.condition.op ?? 'above');
  const [threshold, setThreshold] = useState<number | null>(rule?.condition.threshold ?? null);
  const [minutes, setMinutes] = useState<AlertCondition['minutes']>(rule?.condition.minutes ?? 5);
  const [missing, setMissing] = useState<AlertMissingData>(rule?.missing ?? 'ok');
  const [notify, setNotify] = useState(rule?.notify ?? true);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const create = useAtomSet(createRule, { mode: 'promiseExit' });
  const update = useAtomSet(updateRule, { mode: 'promiseExit' });

  const plain = plainQuery(query);
  const problem = checkSeriesQuery(plain, { alert: true });
  const valid = name.trim().length > 0 && threshold !== null && !problem;
  const unit = thresholdUnit(plain);
  const ruleStage = rule?.stage ?? stage;

  const save = async () => {
    if (!valid || threshold === null) return;
    setBusy(true);
    const payload: AlertRuleInput = {
      name: name.trim(),
      stage: ruleStage,
      query: plain,
      condition: { op, threshold, minutes },
      missing,
      notify,
      enabled,
    };
    let saved: AlertRule | undefined;
    const ok = await report(
      rule
        ? update({ params: { app, id: rule.id }, payload, reactivityKeys: changedKeys(app) })
        : create({ params: { app }, payload, reactivityKeys: changedKeys(app) }),
      (value) => {
        saved = value;
        return rule ? `Saved ${value.name}` : `Created ${value.name}`;
      },
    );
    setBusy(false);
    if (ok && saved) {
      onSaved(saved);
      onClose();
    }
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <DrawerHeader>
        <DrawerTitle>{rule ? `Edit ${rule.name}` : 'New alert rule'}</DrawerTitle>
        <DrawerDescription className="whitespace-normal">
          On {ruleStage}. Checked every minute over the window, two minutes behind so the window's telemetry
          has arrived.
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="grid content-start gap-6">
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input
            value={name}
            maxLength={80}
            placeholder={problem ? 'Requests failing' : describeQuery(plain)}
            onValueChange={setName}
          />
        </Field>

        <FieldSet>
          <FieldLegend>Watch</FieldLegend>
          <div className="rounded-lg border">
            <QueryRow
              query={query}
              app={app}
              stage={ruleStage}
              time={{ range: '24h' }}
              onChange={setQuery}
              removable={false}
              metrics={ALERT_METRICS}
              grouping={false}
              hideable={false}
            />
          </div>
        </FieldSet>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[8rem_minmax(0,1fr)_10rem]">
          <Field>
            <FieldLabel>When it is</FieldLabel>
            <Select items={[...OPS]} value={op} onValueChange={(v) => v && setOp(v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Threshold</FieldLabel>
            <NumberInput
              value={threshold}
              onValueChange={setThreshold}
              step={unit.step}
              largeStep={unit.step * 10}
              {...(unit.min !== undefined ? { min: unit.min } : {})}
              {...(unit.max !== undefined ? { max: unit.max } : {})}
              placeholder="0"
            />
            <FieldDescription>{unit.hint}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Over the last</FieldLabel>
            <Select
              items={WINDOWS}
              value={String(minutes)}
              onValueChange={(v) => v && setMinutes(Number(v) as AlertCondition['minutes'])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOWS.map((w) => (
                  <SelectItem key={w.value} value={w.value}>
                    {w.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Preview
          app={app}
          stage={ruleStage}
          query={plain}
          op={op}
          threshold={threshold ?? undefined}
          minutes={minutes}
          problem={problem}
        />

        <Field>
          <FieldLabel>When the window has no data</FieldLabel>
          <Select items={MISSING_ITEMS} value={missing} onValueChange={(v) => v && setMissing(v)}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MISSING_ITEMS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            No requests behind a percentage or percentile, no values of a custom metric. Counts are never
            missing: none is 0.
          </FieldDescription>
        </Field>

        <div className="flex flex-col gap-4 border-t pt-5">
          <Field orientation="horizontal" className="items-start justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              <FieldLabel>Email when it fires and recovers</FieldLabel>
              <FieldDescription>Sent to the platform's alerts address, like uptime alerts.</FieldDescription>
            </div>
            <Switch checked={notify} onCheckedChange={setNotify} />
          </Field>
          <Field orientation="horizontal" className="justify-between">
            <FieldLabel>Enabled</FieldLabel>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </Field>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!valid || busy}>
          {busy ? 'Saving…' : rule ? 'Save rule' : 'Create rule'}
        </Button>
      </DrawerFooter>
    </form>
  );
}

/** The query over the last day in windows of the rule's size, and how often it would have fired. */
function Preview({
  app,
  stage,
  query,
  op,
  threshold,
  minutes,
  problem,
}: {
  app: string;
  stage: string;
  query: SeriesQuery;
  op: AlertCondition['op'];
  threshold: number | undefined;
  minutes: AlertCondition['minutes'];
  problem: string | undefined;
}) {
  const time: TimeSearch = { range: '24h' };
  const res = WINDOW_RES[minutes];
  const result = useAtomValue(seriesAtom({ app, stage, time, res, query }));
  const fired = useMemo(() => {
    const values = Option.getOrUndefined(AsyncResult.value(result))?.series[0]?.values ?? [];
    if (threshold === undefined) return undefined;
    let count = 0;
    let firing = false;
    for (const v of values) {
      const now = v !== null && breaches(v, { op, threshold });
      if (now && !firing) count++;
      firing = now;
    }
    return count;
  }, [result, threshold, op]);
  if (problem) return null;
  const view: MetricsView = {
    kind: 'metrics',
    queries: [{ id: 'a', ...query, label: describeQuery(query) }],
    chart: 'line',
    ...(threshold !== undefined ? { threshold } : {}),
  };
  return (
    <section aria-label="Preview" className="rounded-lg border">
      <div className="px-4 pt-3 pb-4">
        <p className="mb-2 text-[13px] font-medium">Last 24 hours</p>
        <MetricView view={view} app={app} stage={stage} time={time} height={160} legend={false} res={res} />
      </div>
      <p className="rounded-b-lg border-t bg-muted px-4 py-2.5 text-[13px] text-muted-foreground">
        {fired === undefined
          ? 'Set a threshold to see where the rule would have fired.'
          : fired === 0
            ? 'It would not have fired in the last 24 hours.'
            : `It would have fired ${fired === 1 ? 'once' : `${fired} times`} in the last 24 hours.`}
      </p>
    </section>
  );
}
