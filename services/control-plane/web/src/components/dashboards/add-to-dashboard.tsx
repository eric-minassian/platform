/**
 * "Add to dashboard" from any chart or log view: pick one of the app's
 * dashboards, a cross-app one, or a new one, and the view lands at the
 * bottom of its grid.
 */
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import {
  DASHBOARD_COLUMNS,
  type Dashboard,
  type DashboardWidget,
  type LogsView,
  type MetricsView,
  type SaveDashboardRequest,
} from '@ericminassian/platform-core';
import { useNavigate } from '@tanstack/react-router';
import { Exit, Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApiClient, errorMessage } from '../../client.ts';
import { dashboardsAtom, dashboardsChanged } from '../../data/atoms.ts';
import { Button } from '../ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.tsx';
import { Field, FieldLabel } from '../ui/field.tsx';
import { Input } from '../ui/input.tsx';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group.tsx';

export const createDashboard = ApiClient.mutation('dashboards', 'create');
export const updateDashboard = ApiClient.mutation('dashboards', 'update');

export function newWidgetId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** The dashboard as the save endpoint takes it. */
export function dashboardRequest(d: Dashboard): SaveDashboardRequest {
  return {
    name: d.name,
    widgets: d.widgets,
    ...(d.app ? { app: d.app } : {}),
    ...(d.range ? { range: d.range } : {}),
  };
}

/** Where a new widget goes: full rows below everything already there. */
export function appendWidget(
  widgets: readonly DashboardWidget[],
  widget: Omit<DashboardWidget, 'x' | 'y'>,
): DashboardWidget[] {
  const bottom = widgets.reduce((y, w) => Math.max(y, w.y + w.h), 0);
  const lastRow = widgets.filter((w) => w.y + w.h === bottom);
  const usedWidth = lastRow.reduce((x, w) => Math.max(x, w.x + w.w), 0);
  const fits = lastRow.length > 0 && usedWidth + widget.w <= DASHBOARD_COLUMNS;
  const y = fits ? Math.min(...lastRow.map((w) => w.y)) : bottom;
  return [...widgets, { ...widget, x: fits ? usedWidth : 0, y }];
}

export function AddToDashboardDialog({
  open,
  onOpenChange,
  app,
  stage,
  title,
  view,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: string;
  stage: string;
  title: string;
  view: MetricsView | LogsView;
}) {
  const navigate = useNavigate();
  const result = useAtomValue(dashboardsAtom({}));
  const dashboards = Option.getOrElse(AsyncResult.value(result), (): readonly Dashboard[] => []).filter(
    (d) => !d.app || d.app === app,
  );
  const [choice, setChoice] = useState<string>('new');
  const [name, setName] = useState(`${app} overview`);
  const [busy, setBusy] = useState(false);
  const create = useAtomSet(createDashboard, { mode: 'promiseExit' });
  const update = useAtomSet(updateDashboard, { mode: 'promiseExit' });

  const widget: Omit<DashboardWidget, 'x' | 'y'> = {
    id: newWidgetId(),
    title,
    w: view.kind === 'logs' ? 12 : 6,
    h: view.kind === 'logs' ? 10 : 8,
    view,
    ...(stage !== 'prod' ? { stage } : {}),
    // A widget on a dashboard that spans apps names its app.
    app,
  };

  const save = async () => {
    setBusy(true);
    const target = dashboards.find((d) => d.id === choice);
    const exit = target
      ? await update({
          params: { id: target.id },
          payload: { ...dashboardRequest(target), widgets: appendWidget(target.widgets, widget) },
          reactivityKeys: dashboardsChanged,
        })
      : await create({
          payload: { name: name.trim() || `${app} dashboard`, app, widgets: appendWidget([], widget) },
          reactivityKeys: dashboardsChanged,
        });
    setBusy(false);
    if (Exit.isFailure(exit)) {
      toast.error(errorMessage(exit.cause));
      return;
    }
    onOpenChange(false);
    const saved = exit.value;
    toast.success(`Added to ${saved.name}`, {
      action: {
        label: 'Open',
        onClick: () => void navigate({ to: '/apps/$app/dashboards/$id', params: { app, id: saved.id } }),
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to dashboard</DialogTitle>
          <DialogDescription>{title}</DialogDescription>
        </DialogHeader>
        <RadioGroup value={choice} onValueChange={(v) => setChoice(String(v))} className="gap-1">
          {dashboards.map((d) => (
            <label
              key={d.id}
              className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-accent"
            >
              <RadioGroupItem value={d.id} />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              <span className="text-xs text-muted-foreground">
                {d.app ? d.app : 'all apps'} · {d.widgets.length}{' '}
                {d.widgets.length === 1 ? 'widget' : 'widgets'}
              </span>
            </label>
          ))}
          <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-accent">
            <RadioGroupItem value="new" />
            New dashboard for {app}
          </label>
        </RadioGroup>
        {choice === 'new' && (
          <Field>
            <FieldLabel htmlFor="new-dashboard-name">Name</FieldLabel>
            <Input
              id="new-dashboard-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          </Field>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? 'Adding…' : 'Add widget'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
