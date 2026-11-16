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
import { useNavigate } from '@tanstack/react-router';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { Bell, BellOff, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ApiClient, errorMessage, fresh, timeToLive } from '../../client.ts';
import { columns, DataTable } from '../../components/data-table.tsx';
import { MetricView } from '../../components/metrics/metric-view.tsx';
import { QueryRow } from '../../components/metrics/query-editor.tsx';
import { EmptyState, Loaded, PageHeader, Panel, StatusPill, type Tone } from '../../components/page.tsx';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Field, FieldDescription, FieldLabel } from '../../components/ui/field.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.tsx';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet.tsx';
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

/** A window of this many minutes as the bucket size that draws it. */
const WINDOW_RES: Record<(typeof ALERT_WINDOWS)[number], QueryResolution> = {
  1: '1m',
  5: '5m',
  10: '10m',
  15: '15m',
  30: '30m',
  60: '1h',
};

const changedKeys = (app: string) => [...alertsChanged(app), ...appChanged(app)];

/** `above 2% over 5 minutes`. */
export function describeCondition(rule: { query: SeriesQuery; condition: AlertCondition }): string {
  const f = formatterFor(seriesUnit(rule.query));
  const c = rule.condition;
  return `${c.op} ${f(c.threshold)} over ${c.minutes === 1 ? '1 minute' : c.minutes === 60 ? 'an hour' : `${c.minutes} minutes`}`;
}

const value = (r: AlertRule) =>
  r.value === null || r.value === undefined ? '–' : formatterFor(seriesUnit(r.query))(r.value);

const col = columns<AlertRule>();
const ruleColumns = col.columns([
  col.accessor((r) => (r.state === 'alarm' ? 0 : r.state === 'no_data' ? 1 : 2), {
    id: 'state',
    header: 'State',
    cell: ({ row }) => {
      const r = row.original;
      return r.enabled ? (
        <StatusPill tone={STATE[r.state].tone}>{STATE[r.state].label}</StatusPill>
      ) : (
        <StatusPill tone="muted">Paused</StatusPill>
      );
    },
  }),
  col.accessor('name', {
    header: 'Rule',
    cell: ({ row }) => (
      <div className="max-w-[40rem] min-w-0">
        <div className="truncate font-medium">{row.original.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {describeQuery(row.original.query)} {describeCondition(row.original)}
        </div>
      </div>
    ),
  }),
  col.accessor((r) => r.value ?? -1, {
    id: 'value',
    header: 'Now',
    meta: { numeric: true },
    cell: ({ row }) => value(row.original),
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
        <Bell className="size-4 text-muted-foreground" aria-label="Emails when it fires and recovers" />
      ) : (
        <BellOff className="size-4 text-subtle" aria-label="No email" />
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
                title={`No alert rules on ${stage}`}
                action={<Button onClick={() => setEditing('new')}>Create a rule</Button>}
              >
                A rule watches one metric, such as the share of 5xx responses or a route's p95, and emails
                when it crosses a threshold for a window of minutes. Charts' menus start one too.
              </EmptyState>
            </Panel>
          ) : (
            <Panel flush>
              <DataTable
                columns={ruleColumns}
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
            app={app}
            stage={stage}
            rule={selected}
            time={time.search}
            onEdit={() => setEditing(selected)}
          />
        )}
        <History app={app} stage={stage} time={time.search} rules={all} />
      </div>
      <RuleSheet
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
  const [confirming, setConfirming] = useState(false);
  const view: MetricsView = {
    kind: 'metrics',
    queries: [{ id: 'a', ...rule.query, label: describeQuery(rule.query) }],
    chart: 'line',
    threshold: rule.condition.threshold,
  };
  const setEnabled = (enabled: boolean) =>
    void (async () => {
      const exit = await update({
        params: { app, id: rule.id },
        payload: { ...inputOf(rule), enabled },
        reactivityKeys: changedKeys(app),
      });
      if (exit._tag === 'Failure') toast.error(errorMessage(exit.cause));
      else toast.success(enabled ? `Resumed ${rule.name}` : `Paused ${rule.name}`);
    })();
  return (
    <Panel
      title={rule.name}
      description={
        <span>
          {describeQuery(rule.query)} {describeCondition(rule)}
          {rule.evaluatedAt ? `, checked ${relTime(rule.evaluatedAt)}` : ''}
        </span>
      }
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
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${rule.name}`}
            onClick={() => setConfirming(true)}
          >
            <Trash2 />
          </Button>
        </>
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
      <p className="mt-2 text-xs text-muted-foreground">
        Each point is one {rule.condition.minutes}-minute window; the dashed line is the threshold. With no
        data the rule
        {rule.missing === 'keep'
          ? ' keeps its state'
          : rule.missing === 'ok'
            ? ' counts as OK'
            : ' counts as firing'}
        .
      </p>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {rule.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The rule stops being checked; its history stays for 90 days.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                void (async () => {
                  const exit = await remove({
                    params: { app, id: rule.id },
                    reactivityKeys: changedKeys(app),
                  });
                  if (exit._tag === 'Failure') toast.error(errorMessage(exit.cause));
                  else toast.success(`Deleted ${rule.name}`);
                })()
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
    <Panel flush title="History" description="state changes in the window, newest first">
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
                    className="grid grid-cols-[8.5rem_6.5rem_1fr] items-center gap-3 border-b px-4 py-2 text-sm last:border-0"
                  >
                    <span className="text-muted-foreground tabular">{when(e.ts)}</span>
                    <StatusPill tone={STATE[e.to].tone}>
                      {e.to === 'alarm' ? 'Fired' : e.to === 'ok' ? 'Recovered' : 'No data'}
                    </StatusPill>
                    <span className="min-w-0 truncate">
                      {e.name}
                      <span className="text-muted-foreground">
                        {e.value === null ? ', no data' : `, ${f(e.value)} against ${f(e.threshold)}`}
                      </span>
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

function RuleSheet({
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
  const open = editing !== null;
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" size="lg" className="gap-0 overflow-y-auto">
        {open && (
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
      </SheetContent>
    </Sheet>
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
  const [threshold, setThreshold] = useState(rule ? String(rule.condition.threshold) : '');
  const [minutes, setMinutes] = useState<AlertCondition['minutes']>(rule?.condition.minutes ?? 5);
  const [missing, setMissing] = useState<AlertMissingData>(rule?.missing ?? 'ok');
  const [notify, setNotify] = useState(rule?.notify ?? true);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const create = useAtomSet(createRule, { mode: 'promiseExit' });
  const update = useAtomSet(updateRule, { mode: 'promiseExit' });

  const plain = plainQuery(query);
  const problem = checkSeriesQuery(plain, { alert: true });
  const limit = Number(threshold);
  const valid = name.trim().length > 0 && threshold.trim() !== '' && Number.isFinite(limit) && !problem;
  const unit = seriesUnit(plain);

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    const payload: AlertRuleInput = {
      name: name.trim(),
      stage: rule?.stage ?? stage,
      query: plain,
      condition: { op, threshold: limit, minutes },
      missing,
      notify,
      enabled,
    };
    const exit = rule
      ? await update({ params: { app, id: rule.id }, payload, reactivityKeys: changedKeys(app) })
      : await create({ params: { app }, payload, reactivityKeys: changedKeys(app) });
    setBusy(false);
    if (exit._tag === 'Failure') {
      toast.error(errorMessage(exit.cause));
      return;
    }
    toast.success(rule ? `Saved ${exit.value.name}` : `Created ${exit.value.name}`);
    onSaved(exit.value);
    onClose();
  };

  return (
    <form
      className="flex min-h-full flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <SheetHeader>
        <SheetTitle>{rule ? `Edit ${rule.name}` : 'New alert rule'}</SheetTitle>
        <SheetDescription>
          On {rule?.stage ?? stage}. Checked every minute over the window, two minutes behind so the window's
          telemetry has arrived.
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-1 flex-col gap-5 px-4 pb-4">
        <Field>
          <FieldLabel htmlFor="rule-name">Name</FieldLabel>
          <Input
            id="rule-name"
            value={name}
            maxLength={80}
            placeholder="Requests failing"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="grid gap-2">
          <span className="text-sm font-medium">Watch</span>
          <div className="-mx-4 border-y">
            <QueryRow
              query={query}
              app={app}
              stage={rule?.stage ?? stage}
              time={{ range: '24h' }}
              onChange={setQuery}
              removable={false}
              metrics={ALERT_METRICS}
              grouping={false}
              hideable={false}
            />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field>
            <FieldLabel>When it is</FieldLabel>
            <Select value={op} onValueChange={(v) => setOp(v as AlertCondition['op'])}>
              <SelectTrigger aria-label="Above or below">
                <SelectValue>{op}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="above">above</SelectItem>
                <SelectItem value="below">below</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="rule-threshold">Threshold</FieldLabel>
            <Input
              id="rule-threshold"
              inputMode="decimal"
              value={threshold}
              placeholder="0"
              className="tabular"
              onChange={(e) => setThreshold(e.target.value)}
            />
            <FieldDescription>
              {unit === 'percent'
                ? 'percent, 0 to 100'
                : unit === 'ms'
                  ? 'milliseconds'
                  : unit === 'per_second'
                    ? 'per second'
                    : unit}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Over the last</FieldLabel>
            <Select
              value={String(minutes)}
              onValueChange={(v) => setMinutes(Number(v) as AlertCondition['minutes'])}
            >
              <SelectTrigger aria-label="Window">
                <SelectValue>
                  {minutes === 60 ? 'hour' : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ALERT_WINDOWS.map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {m === 60 ? 'hour' : `${m} ${m === 1 ? 'minute' : 'minutes'}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Preview
          app={app}
          stage={rule?.stage ?? stage}
          query={plain}
          op={op}
          threshold={Number.isFinite(limit) && threshold.trim() ? limit : undefined}
          minutes={minutes}
          problem={problem}
        />
        <Field>
          <FieldLabel>When the window has no data</FieldLabel>
          <Select value={missing} onValueChange={(v) => setMissing(v as AlertMissingData)}>
            <SelectTrigger aria-label="Missing data">
              <SelectValue>{MISSING[missing]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(MISSING) as AlertMissingData[]).map((m) => (
                <SelectItem key={m} value={m}>
                  {MISSING[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            No requests behind a percentage or percentile, no values of a custom metric. Counts are never
            missing: none is 0.
          </FieldDescription>
        </Field>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="rule-notify" className="flex-col items-start gap-1 font-normal">
            <span className="text-sm font-medium">Email when it fires and recovers</span>
            <span className="text-xs text-muted-foreground">
              Sent to the platform's alerts address, like uptime alerts.
            </span>
          </Label>
          <Switch id="rule-notify" checked={notify} onCheckedChange={setNotify} />
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="rule-enabled" className="text-sm font-medium">
            Enabled
          </Label>
          <Switch id="rule-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </div>
      <SheetFooter className="flex-row justify-end border-t">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || busy}>
          {busy ? 'Saving…' : rule ? 'Save rule' : 'Create rule'}
        </Button>
      </SheetFooter>
    </form>
  );
}

const MISSING: Record<AlertMissingData, string> = {
  ok: 'Treat it as OK',
  alarm: 'Treat it as firing',
  keep: 'Keep the current state',
};

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
    <div className="rounded-lg border bg-background p-3">
      <MetricView view={view} app={app} stage={stage} time={time} height={170} legend={false} res={res} />
      <p className="mt-2 text-xs text-muted-foreground">
        {fired === undefined
          ? 'Set a threshold to see where the rule would have fired in the last 24 hours.'
          : fired === 0
            ? 'It would not have fired in the last 24 hours.'
            : `It would have fired ${fired === 1 ? 'once' : `${fired} times`} in the last 24 hours.`}
      </p>
    </div>
  );
}
