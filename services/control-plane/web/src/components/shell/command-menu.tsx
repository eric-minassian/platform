/**
 * ⌘K: jump to any app, any page of the current app, a time range, or a
 * trace by its id.
 */
import { useAtomValue } from '@effect/atom-react';
import { useNavigate } from '@tanstack/react-router';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { Boxes, ChartGantt, Clock, LayoutGrid, Shield } from 'lucide-react';
import { useEffect, useState } from 'react';
import { appsAtom } from '../../data/atoms.ts';
import { useLiveManifest } from '../../data/hooks.ts';
import { useAppName, useStage, useTime } from '../../lib/hooks.ts';
import { RANGE_PRESETS } from '../../lib/time.ts';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '../ui/command.tsx';
import { APP_NAV } from './nav.ts';

const TRACE_ID = /^[0-9a-f]{16,64}$/i;

export function useCommandMenu(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return [open, setOpen];
}

export function CommandMenu({
  open,
  onOpenChange,
  isAdmin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
}) {
  const navigate = useNavigate();
  const app = useAppName();
  const stage = useStage();
  const time = useTime();
  const manifest = useLiveManifest(app, stage);
  const apps = Option.getOrElse(AsyncResult.value(useAtomValue(appsAtom)), () => []);
  const [query, setQuery] = useState('');
  const trace = query.trim();

  const run = (action: () => void) => {
    onOpenChange(false);
    setQuery('');
    action();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command menu" description="Jump to a page">
      <CommandInput
        placeholder="Type a page, an app, a range, or paste a trace id"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        {app && TRACE_ID.test(trace) && (
          <CommandGroup heading="Trace">
            <CommandItem
              value={`trace ${trace}`}
              onSelect={() =>
                run(
                  () =>
                    void navigate({
                      to: '/apps/$app/traces/$trace',
                      params: { app, trace: trace.toLowerCase() },
                    }),
                )
              }
            >
              <ChartGantt />
              Open trace <span className="font-mono">{trace}</span>
            </CommandItem>
          </CommandGroup>
        )}
        {app && (
          <CommandGroup heading={app}>
            {APP_NAV.flatMap((g) => g.items)
              .filter((item) => !item.when || !manifest || item.when(manifest))
              .map((item) => (
                <CommandItem
                  key={item.page}
                  value={`${app} ${item.label}`}
                  onSelect={() => run(() => void navigate({ to: item.page, params: { app } }))}
                >
                  <item.icon />
                  {item.label}
                </CommandItem>
              ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Apps">
          {apps.map((a) => (
            <CommandItem
              key={a.app.name}
              value={`app ${a.app.name} ${a.app.description ?? ''}`}
              onSelect={() => run(() => void navigate({ to: '/apps/$app', params: { app: a.app.name } }))}
            >
              <Boxes />
              {a.app.name}
              {a.app.description && (
                <span className="truncate text-xs text-muted-foreground">{a.app.description}</span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Platform">
          <CommandItem value="all apps" onSelect={() => run(() => void navigate({ to: '/' }))}>
            <Boxes />
            All apps
          </CommandItem>
          <CommandItem value="dashboards" onSelect={() => run(() => void navigate({ to: '/dashboards' }))}>
            <LayoutGrid />
            Dashboards
          </CommandItem>
          {isAdmin && (
            <CommandItem
              value="platform members cost edge"
              onSelect={() => run(() => void navigate({ to: '/platform' }))}
            >
              <Shield />
              Platform
            </CommandItem>
          )}
        </CommandGroup>
        <CommandGroup heading="Time range">
          {RANGE_PRESETS.map((p) => (
            <CommandItem
              key={p.value}
              value={`time ${p.label} ${p.value}`}
              onSelect={() => run(() => time.set({ range: p.value }))}
            >
              <Clock />
              {p.label}
              <CommandShortcut>{p.value}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
