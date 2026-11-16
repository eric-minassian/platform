/**
 * Adds or edits one dashboard widget: a chart built like the Metrics
 * explorer, or a log search; for dashboards that span apps, which app it
 * reads. The preview is the widget as it will draw.
 */
import { useAtomValue } from '@effect/atom-react';
import type {
  ChartKind,
  DashboardWidget,
  LogLevelName,
  LogsView,
  MetricsView,
} from '@ericminassian/platform-core';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { useState } from 'react';
import { appsAtom } from '../../data/atoms.ts';
import type { TimeSearch } from '../../lib/time.ts';
import { QueryEditor } from '../metrics/query-editor.tsx';
import { Segmented } from '../segmented.tsx';
import { Button } from '../ui/button.tsx';
import { Field, FieldLabel } from '../ui/field.tsx';
import { Input } from '../ui/input.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.tsx';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '../ui/sheet.tsx';
import { ValuePicker } from '../value-picker.tsx';
import { newWidgetId } from './add-to-dashboard.tsx';
import { WidgetBody } from './widget.tsx';

const DEFAULT_METRICS: MetricsView = {
  kind: 'metrics',
  queries: [{ id: 'a', metric: 'requests', stat: 'count', groupBy: 'status' }],
  chart: 'bar',
};

const CHARTS: ReadonlyArray<{ value: ChartKind; label: string }> = [
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'bar', label: 'Bar' },
  { value: 'heatmap', label: 'Heatmap' },
  { value: 'number', label: 'Number' },
  { value: 'table', label: 'Table' },
];

const LEVELS: readonly LogLevelName[] = ['error', 'warn', 'info', 'debug', 'system'];

export function WidgetEditor({
  open,
  widget,
  dashboardApp,
  stage,
  time,
  utc,
  onClose,
  onSave,
}: {
  open: boolean;
  /** The widget being edited; none adds a new one. */
  widget: DashboardWidget | undefined;
  /** The dashboard's app; a dashboard without one asks each widget for its app. */
  dashboardApp: string | undefined;
  stage: string;
  time: TimeSearch;
  utc: boolean;
  onClose: () => void;
  onSave: (widget: Omit<DashboardWidget, 'x' | 'y'> & Partial<Pick<DashboardWidget, 'x' | 'y'>>) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent side="right" size="xl" className="gap-0 overflow-y-auto">
        {open && (
          <Editor
            key={widget?.id ?? 'new'}
            widget={widget}
            dashboardApp={dashboardApp}
            stage={stage}
            time={time}
            utc={utc}
            onClose={onClose}
            onSave={onSave}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function Editor({
  widget,
  dashboardApp,
  stage,
  time,
  utc,
  onClose,
  onSave,
}: {
  widget: DashboardWidget | undefined;
  dashboardApp: string | undefined;
  stage: string;
  time: TimeSearch;
  utc: boolean;
  onClose: () => void;
  onSave: (widget: Omit<DashboardWidget, 'x' | 'y'> & Partial<Pick<DashboardWidget, 'x' | 'y'>>) => void;
}) {
  const apps = Option.getOrElse(AsyncResult.value(useAtomValue(appsAtom)), () => []);
  const [title, setTitle] = useState(widget?.title ?? '');
  const [app, setApp] = useState<string | undefined>(widget?.app ?? dashboardApp ?? apps[0]?.app.name);
  const [widgetStage, setWidgetStage] = useState(widget?.stage ?? stage);
  const [kind, setKind] = useState<'metrics' | 'logs'>(widget?.view.kind ?? 'metrics');
  const [metrics, setMetrics] = useState<MetricsView>(
    widget?.view.kind === 'metrics' ? widget.view : DEFAULT_METRICS,
  );
  const [logs, setLogs] = useState<LogsView>(
    widget?.view.kind === 'logs' ? widget.view : { kind: 'logs', filters: { levels: ['error'] } },
  );
  const view = kind === 'metrics' ? metrics : logs;
  const target = app ?? dashboardApp;
  const stages = apps.find((a) => a.app.name === target)?.stages.map((s) => s.stage) ?? ['prod'];
  const valid = title.trim().length > 0 && !!target;

  const save = () => {
    if (!valid) return;
    onSave({
      id: widget?.id ?? newWidgetId(),
      title: title.trim(),
      w: widget?.w ?? (kind === 'logs' ? 12 : 6),
      h: widget?.h ?? (kind === 'logs' ? 10 : 8),
      ...(widget ? { x: widget.x, y: widget.y } : {}),
      view,
      // A widget names its app only on a dashboard that spans apps.
      ...(target && target !== dashboardApp ? { app: target } : {}),
      ...(widgetStage !== 'prod' ? { stage: widgetStage } : {}),
    });
    onClose();
  };

  return (
    <form
      className="flex min-h-full flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <SheetHeader>
        <SheetTitle>{widget ? `Edit ${widget.title}` : 'Add a widget'}</SheetTitle>
        <SheetDescription>It follows the dashboard's time window.</SheetDescription>
      </SheetHeader>
      <div className="flex flex-1 flex-col gap-5 px-4 pb-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto_auto]">
          <Field>
            <FieldLabel htmlFor="widget-title">Title</FieldLabel>
            <Input
              id="widget-title"
              value={title}
              maxLength={120}
              placeholder="Requests by status"
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          {!dashboardApp && (
            <Field>
              <FieldLabel>App</FieldLabel>
              <Select value={target ?? ''} onValueChange={(v) => setApp(String(v))}>
                <SelectTrigger aria-label="App" className="min-w-36">
                  <SelectValue>{target ?? 'Pick an app'}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {apps.map((a) => (
                    <SelectItem key={a.app.name} value={a.app.name}>
                      {a.app.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field>
            <FieldLabel>Stage</FieldLabel>
            <Select value={widgetStage} onValueChange={(v) => setWidgetStage(String(v))}>
              <SelectTrigger aria-label="Stage" className="min-w-28">
                <SelectValue>{widgetStage}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {stages.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Segmented
          label="Widget type"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'metrics', label: 'Chart' },
            { value: 'logs', label: 'Log lines' },
          ]}
        />
        {kind === 'metrics' && target && (
          <>
            <div className="-mx-4">
              <QueryEditor
                view={metrics}
                app={target}
                stage={widgetStage}
                time={time}
                onChange={setMetrics}
              />
            </div>
            <Segmented
              label="Chart"
              value={metrics.chart}
              onChange={(chart) => setMetrics({ ...metrics, chart })}
              options={CHARTS}
            />
          </>
        )}
        {kind === 'logs' && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Search text"
              className="h-8 max-w-sm font-mono text-[12.5px]"
              placeholder="Search text or a filter pattern"
              value={logs.q ?? ''}
              onChange={(e) => {
                const { q: _drop, ...rest } = logs;
                setLogs(e.target.value ? { ...rest, q: e.target.value } : rest);
              }}
            />
            <ValuePicker
              label="Any level"
              options={LEVELS.map((value) => ({ value }))}
              selected={logs.filters?.levels ?? []}
              onChange={(levels) => {
                const { levels: _drop, ...filters } = logs.filters ?? {};
                setLogs({
                  ...logs,
                  filters: levels.length ? { ...filters, levels: levels as LogLevelName[] } : filters,
                });
              }}
            />
          </div>
        )}
        <div className="rounded-lg border bg-card p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Preview</p>
          <div className="h-64 overflow-hidden">
            <WidgetBody
              widget={{
                id: 'preview',
                title,
                x: 0,
                y: 0,
                w: 6,
                h: 8,
                view,
                ...(target ? { app: target } : {}),
                stage: widgetStage,
              }}
              app={target}
              stage={widgetStage}
              time={time}
              height={230}
              utc={utc}
            />
          </div>
        </div>
      </div>
      <SheetFooter className="flex-row justify-end border-t">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid}>
          {widget ? 'Save widget' : 'Add widget'}
        </Button>
      </SheetFooter>
    </form>
  );
}
