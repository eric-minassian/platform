/**
 * One dashboard: widgets on a 12-column grid that share the page's time
 * window. Edit lays them out by dragging and resizing (react-grid-layout);
 * nothing is saved until Save, so an edit can be thrown away.
 */
import 'react-grid-layout/css/styles.css';
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { DASHBOARD_COLUMNS, type Dashboard, type DashboardWidget } from '@ericminassian/platform-core';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Exit } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { Copy, GripVertical, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import ReactGridLayout, { type Layout, useContainerWidth } from 'react-grid-layout';
import { toast } from 'sonner';
import { ApiClient, errorMessage } from '../../client.ts';
import {
  appendWidget,
  dashboardRequest,
  newWidgetId,
  updateDashboard,
} from '../../components/dashboards/add-to-dashboard.tsx';
import { WidgetEditor } from '../../components/dashboards/widget-editor.tsx';
import { WidgetBody } from '../../components/dashboards/widget.tsx';
import { EmptyState, ErrorNotice, Loading, PageHeader } from '../../components/page.tsx';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.tsx';
import { Input } from '../../components/ui/input.tsx';
import { dashboardAtom, dashboardsChanged } from '../../data/atoms.ts';
import { relTime } from '../../format.ts';
import { useAppName, useStage, useTime } from '../../lib/hooks.ts';
import { usePrefs } from '../../lib/prefs.tsx';
import { cn } from '../../lib/utils.ts';
import { appDashboardRoute, dashboardRoute } from '../../router.tsx';

const removeDashboard = ApiClient.mutation('dashboards', 'remove');

/** Height of one grid row, px; widgets are 2 to 40 rows tall. */
const ROW = 32;
const MARGIN = 12;

export function DashboardPage() {
  const { id } = dashboardRoute.useParams();
  return <Board id={id} />;
}

export function AppDashboardPage() {
  const { id } = appDashboardRoute.useParams();
  return <Board id={id} />;
}

function Board({ id }: { id: string }) {
  const result = useAtomValue(dashboardAtom(id));
  return AsyncResult.match(result, {
    onInitial: () => <Loading className="h-96" />,
    onFailure: ({ cause }) => <ErrorNotice error={cause} />,
    onSuccess: ({ value }) => <BoardView dashboard={value} />,
  });
}

function BoardView({ dashboard }: { dashboard: Dashboard }) {
  const app = useAppName();
  const stage = useStage();
  const time = useTime();
  const { utc } = usePrefs();
  const navigate = useNavigate();
  const search: { edit?: unknown; range?: unknown; from?: unknown } = useSearch({ strict: false });
  const editing = search.edit === true;
  // An edit's unsaved changes; outside an edit the board shows what's saved, another member's change included.
  const [draft, setDraft] = useState<{ widgets: readonly DashboardWidget[]; name: string } | null>(null);
  const [wasEditing, setWasEditing] = useState(editing);
  if (wasEditing !== editing) {
    setWasEditing(editing);
    setDraft(null);
  }
  const saved = { widgets: dashboard.widgets, name: dashboard.name };
  const current = editing ? (draft ?? saved) : saved;
  const [editor, setEditor] = useState<DashboardWidget | 'new' | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = useAtomSet(updateDashboard, { mode: 'promiseExit' });
  const remove = useAtomSet(removeDashboard, { mode: 'promiseExit' });
  const { width, containerRef, mounted } = useContainerWidth();

  // A dashboard opens on its own range when the link doesn't name one (the time picker always names one).
  useEffect(() => {
    if (search.range === undefined && search.from === undefined && dashboard.range) {
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, range: dashboard.range }),
        replace: true,
      } as never);
    }
  }, [search.range, search.from, dashboard.range, navigate]);

  const setEditing = (on: boolean) =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, edit: on || undefined }),
      replace: true,
    } as never);

  const persist = async (widgets: readonly DashboardWidget[], nextName = current.name) => {
    setBusy(true);
    const exit = await save({
      params: { id: dashboard.id },
      payload: { ...dashboardRequest(dashboard), name: nextName.trim() || dashboard.name, widgets },
      reactivityKeys: dashboardsChanged,
    });
    setBusy(false);
    if (Exit.isFailure(exit)) {
      toast.error(errorMessage(exit.cause));
      return false;
    }
    return true;
  };

  const widgets = current.widgets;
  const layout: Layout = widgets.map((w) => ({
    i: w.id,
    x: w.x,
    y: w.y,
    w: w.w,
    h: w.h,
    minW: 2,
    minH: 4,
    maxH: 40,
  }));
  const onLayoutChange = (next: Layout) => {
    if (!editing) return;
    setDraft((prev) => {
      const base = prev ?? saved;
      return {
        ...base,
        widgets: base.widgets.map((w) => {
          const l = next.find((item) => item.i === w.id);
          return l ? { ...w, x: l.x, y: l.y, w: l.w, h: l.h } : w;
        }),
      };
    });
  };

  // In an edit, changes wait for Save; outside one, adding, changing or removing a widget saves at once.
  const change = (next: readonly DashboardWidget[]) => {
    if (editing) setDraft({ ...current, widgets: next });
    else void persist(next);
  };
  const upsert = (w: Omit<DashboardWidget, 'x' | 'y'> & Partial<Pick<DashboardWidget, 'x' | 'y'>>) =>
    change(
      widgets.some((d) => d.id === w.id)
        ? widgets.map((d) => (d.id === w.id ? { ...d, ...w } : d))
        : appendWidget(widgets, w),
    );

  return (
    <>
      <PageHeader
        title={
          editing ? (
            <Input
              aria-label="Dashboard name"
              value={current.name}
              maxLength={80}
              onChange={(e) => setDraft({ ...current, name: e.target.value })}
              className="h-8 max-w-md text-lg font-semibold"
            />
          ) : (
            dashboard.name
          )
        }
        description={`${dashboard.app ? dashboard.app : 'All apps'} · ${dashboard.widgets.length} ${dashboard.widgets.length === 1 ? 'widget' : 'widgets'} · updated ${relTime(dashboard.updatedAt)} by ${dashboard.updatedBy}`}
        actions={
          editing ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setEditor('new')}>
                <Plus />
                Add widget
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    if (await persist(current.widgets)) {
                      toast.success('Saved the dashboard');
                      setEditing(false);
                    }
                  })()
                }
              >
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setEditor('new')}>
                <Plus />
                Add widget
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil />
                Edit layout
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" />}>
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
                    <Trash2 />
                    Delete dashboard
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )
        }
      />
      <div
        ref={containerRef}
        className={cn(
          '-mx-3',
          editing &&
            'rounded-lg bg-[radial-gradient(var(--input)_1px,transparent_1px)] [background-size:16px_16px]',
        )}
      >
        {widgets.length === 0 ? (
          <div className="mx-3 rounded-lg border bg-card">
            <EmptyState
              title="No widgets yet"
              action={<Button onClick={() => setEditor('new')}>Add a widget</Button>}
            >
              Add a chart or a log search. Charts elsewhere in the console can add themselves from their menu.
            </EmptyState>
          </div>
        ) : (
          mounted && (
            <ReactGridLayout
              layout={layout}
              width={width}
              gridConfig={{
                cols: DASHBOARD_COLUMNS,
                rowHeight: ROW,
                margin: [MARGIN, MARGIN],
                containerPadding: [MARGIN, 0],
              }}
              dragConfig={{ enabled: editing, handle: '.widget-handle' }}
              resizeConfig={{ enabled: editing }}
              onLayoutChange={onLayoutChange}
            >
              {widgets.map((w) => (
                <div key={w.id}>
                  <WidgetFrame
                    widget={w}
                    editing={editing}
                    onEdit={() => setEditor(w)}
                    onDuplicate={() => upsert({ ...w, id: newWidgetId(), title: `${w.title} (copy)` })}
                    onRemove={() => change(widgets.filter((d) => d.id !== w.id))}
                    openLink={widgetLink(w, dashboard.app ?? app)}
                  >
                    <WidgetBody
                      widget={w}
                      app={dashboard.app ?? app}
                      stage={stage}
                      time={time.search}
                      // The widget's box less its 40px header and 12px bottom padding.
                      height={w.h * ROW + (w.h - 1) * MARGIN - 52}
                      utc={utc}
                    />
                  </WidgetFrame>
                </div>
              ))}
            </ReactGridLayout>
          )
        )}
      </div>
      <WidgetEditor
        open={editor !== null}
        widget={editor === 'new' || editor === null ? undefined : editor}
        dashboardApp={dashboard.app}
        stage={stage}
        time={time.search}
        utc={utc}
        onClose={() => setEditor(null)}
        onSave={upsert}
      />
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {dashboard.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It's gone for every member. The charts' data stays.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                void (async () => {
                  const exit = await remove({
                    params: { id: dashboard.id },
                    reactivityKeys: dashboardsChanged,
                  });
                  if (Exit.isFailure(exit)) {
                    toast.error(errorMessage(exit.cause));
                    return;
                  }
                  toast.success(`Deleted ${dashboard.name}`);
                  void (app
                    ? navigate({ to: '/apps/$app/dashboards', params: { app } })
                    : navigate({ to: '/dashboards' }));
                })()
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Where "Open" takes a widget: its view in the explorer or the log page. */
function widgetLink(w: DashboardWidget, fallbackApp: string | undefined): ReactNode {
  const app = w.app ?? fallbackApp;
  if (!app) return null;
  const view = w.view;
  if (view.kind === 'metrics') {
    return (
      <Link
        to="/apps/$app/metrics"
        params={{ app }}
        search={(prev) => ({ ...prev, view, ...(w.stage ? { stage: w.stage } : {}) })}
      />
    );
  }
  return (
    <Link
      to="/apps/$app/logs"
      params={{ app }}
      search={(prev) => ({
        ...prev,
        q: view.q,
        f: view.filters,
        insights: view.insights,
        ...(w.stage ? { stage: w.stage } : {}),
      })}
    />
  );
}

function WidgetFrame({
  widget,
  editing,
  onEdit,
  onDuplicate,
  onRemove,
  openLink,
  children,
}: {
  widget: DashboardWidget;
  editing: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  openLink: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={cn('flex h-full min-w-0 flex-col rounded-lg border bg-card', editing && 'ring-1 ring-input')}
    >
      <header
        className={cn(
          'flex h-10 shrink-0 items-center gap-2 px-3',
          editing && 'widget-handle cursor-grab active:cursor-grabbing',
        )}
      >
        {editing && <GripVertical className="size-4 text-muted-foreground" aria-hidden />}
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{widget.title}</h2>
        {widget.app && <span className="text-xs text-muted-foreground">{widget.app}</span>}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-xs" aria-label={`${widget.title}: more`} />}
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {openLink && <DropdownMenuItem render={openLink as React.ReactElement}>Open</DropdownMenuItem>}
            <DropdownMenuItem onClick={onEdit}>
              <Pencil />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDuplicate}>
              <Copy />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              <Trash2 />
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden px-3 pb-3">{children}</div>
    </section>
  );
}
