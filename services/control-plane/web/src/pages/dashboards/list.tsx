/**
 * Dashboards: an app's own (in its sidebar), or every one, including those
 * that span apps (at the top level). Shared by every member who can see them.
 */
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { Dashboard } from '@ericminassian/platform-core';
import { useNavigate } from '@tanstack/react-router';
import { Exit } from 'effect';
import { LayoutGrid, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '../../client.ts';
import { createDashboard } from '../../components/dashboards/add-to-dashboard.tsx';
import { columns, DataTable } from '../../components/data-table.tsx';
import { EmptyState, Loaded, PageHeader, Panel } from '../../components/page.tsx';
import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Field, FieldLabel } from '../../components/ui/field.tsx';
import { Input } from '../../components/ui/input.tsx';
import { dashboardsAtom, dashboardsChanged } from '../../data/atoms.ts';
import { relTime } from '../../format.ts';
import { useAppName } from '../../lib/hooks.ts';

const col = columns<Dashboard>();
const dashboardColumns = (inApp: boolean) =>
  col.columns([
    col.accessor('name', {
      header: 'Dashboard',
      cell: ({ getValue }) => (
        <span className="flex items-center gap-2 font-medium">
          <LayoutGrid className="size-4 text-muted-foreground" />
          {getValue()}
        </span>
      ),
    }),
    ...(inApp
      ? []
      : [
          col.accessor((d) => d.app ?? '', {
            id: 'scope',
            header: 'App',
            cell: ({ getValue }) => (
              <span className={getValue() ? undefined : 'text-muted-foreground'}>
                {getValue() || 'All apps'}
              </span>
            ),
          }),
        ]),
    col.accessor((d) => d.widgets.length, { id: 'widgets', header: 'Widgets', meta: { numeric: true } }),
    col.accessor('updatedAt', {
      header: 'Updated',
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {relTime(row.original.updatedAt)} by {row.original.updatedBy}
        </span>
      ),
    }),
  ]);

export function DashboardsPage() {
  return <Dashboards app={undefined} />;
}

export function AppDashboardsPage() {
  return <Dashboards app={useAppName()} />;
}

function Dashboards({ app }: { app: string | undefined }) {
  const navigate = useNavigate();
  const result = useAtomValue(dashboardsAtom(app ? { app } : {}));
  const [creating, setCreating] = useState(false);
  const open = (d: Dashboard) =>
    void (app
      ? navigate({ to: '/apps/$app/dashboards/$id', params: { app, id: d.id } })
      : d.app
        ? navigate({ to: '/apps/$app/dashboards/$id', params: { app: d.app, id: d.id } })
        : navigate({ to: '/dashboards/$id', params: { id: d.id } }));
  return (
    <>
      <PageHeader
        title="Dashboards"
        description={app ? `${app}'s dashboards, and those that span apps.` : 'Every dashboard you can see.'}
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            New dashboard
          </Button>
        }
      />
      <Panel flush>
        <Loaded result={result} loading={<div className="h-40" />}>
          {(list) => (
            <DataTable
              columns={dashboardColumns(!!app)}
              data={list.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))}
              getRowId={(d) => d.id}
              onRowClick={open}
              empty={
                <EmptyState
                  title="No dashboards yet"
                  action={<Button onClick={() => setCreating(true)}>Create one</Button>}
                >
                  Put the charts and log searches you check together on one page. Any chart's menu can add
                  itself to one.
                </EmptyState>
              }
            />
          )}
        </Loaded>
      </Panel>
      <CreateDialog app={app} open={creating} onOpenChange={setCreating} onCreated={open} />
    </>
  );
}

function CreateDialog({
  app,
  open,
  onOpenChange,
  onCreated,
}: {
  app: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (d: Dashboard) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const create = useAtomSet(createDashboard, { mode: 'promiseExit' });
  const save = async () => {
    setBusy(true);
    const exit = await create({
      payload: { name: name.trim(), ...(app ? { app } : {}), range: '24h', widgets: [] },
      reactivityKeys: dashboardsChanged,
    });
    setBusy(false);
    if (Exit.isFailure(exit)) {
      toast.error(errorMessage(exit.cause));
      return;
    }
    setName('');
    onOpenChange(false);
    onCreated(exit.value);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New dashboard</DialogTitle>
          <DialogDescription>
            {app ? `It belongs to ${app}.` : 'It can show any app you can see.'}
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="dashboard-name">Name</FieldLabel>
          <Input
            id="dashboard-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && void save()}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
