/**
 * ⌘K: jump to any app, any page of the current app, a time range, or a
 * trace by its id, or switch the color scheme.
 */
import { useAtomValue } from '@effect/atom-react';
import { useNavigate } from '@tanstack/react-router';
import {
  Dialog,
  DialogBackdrop,
  DialogContent,
  DialogTitle,
  type createDialogController,
} from '@ui-sdk/react/dialog';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { Boxes, ChartGantt, Clock, Monitor, Moon, Shield, Sun } from 'lucide-react';
import { useState } from 'react';
import { appsAtom } from '../../data/atoms.ts';
import { useLiveManifest } from '../../data/hooks.ts';
import { colorScheme } from '../../lib/color-scheme.ts';
import { useAppName, useStage, useTime } from '../../lib/hooks.ts';
import { RANGE_PRESETS } from '../../lib/time.ts';
import { cn } from '../../lib/utils.ts';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '../ui/command.tsx';
import { backdrop } from '../ui/dialog.tsx';
import { APP_NAV } from './nav.ts';
import { AppMark } from './sidebar.tsx';

const TRACE_ID = /^[0-9a-f]{16,64}$/i;

export function CommandMenu({
  controller,
  isAdmin,
}: {
  controller: ReturnType<typeof createDialogController<unknown, unknown>>;
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
  const pages = app
    ? APP_NAV.flatMap((g) => g.items).filter((item) => !item.when || !manifest || item.when(manifest))
    : [];

  const run = (value: string) => {
    controller.close();
    setQuery('');
    const [kind, rest] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)];
    if (kind === 'trace' && app)
      void navigate({ to: '/apps/$app/traces/$trace', params: { app, trace: rest } });
    else if (kind === 'page' && app) void navigate({ to: rest as never, params: { app } as never });
    else if (kind === 'app') void navigate({ to: '/apps/$app', params: { app: rest } });
    else if (kind === 'go') void navigate({ to: rest as '/' | '/platform' });
    else if (kind === 'time') time.set({ range: rest });
    else if (kind === 'theme') colorScheme.set(rest as 'light' | 'dark' | 'system');
  };

  return (
    <Dialog controller={controller} onOpenChange={(open) => !open && setQuery('')}>
      <DialogBackdrop className={backdrop} />
      <DialogContent
        className={cn(
          'fixed inset-x-0 top-[12dvh] z-50 mx-auto mb-0 flex h-fit max-h-[min(34rem,76dvh)] w-[min(40rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl bg-popover p-0 text-foreground shadow-dialog outline-hidden popup-motion',
        )}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <Command query={query} onQueryChange={setQuery} onAction={run}>
          <CommandInput
            aria-label="Search pages, apps and traces"
            placeholder="Search pages, apps, a time range, or paste a trace id…"
          />
          <CommandEmpty>Nothing matches.</CommandEmpty>
          <CommandList>
            {app && TRACE_ID.test(trace) && (
              <CommandGroup>
                <CommandGroupLabel>Trace</CommandGroupLabel>
                <CommandItem value={`trace:${trace.toLowerCase()}`} label={trace} keywords={[trace]}>
                  <ChartGantt />
                  Open trace <span className="font-mono text-[13px]">{trace}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {app && (
              <CommandGroup>
                <CommandGroupLabel>{app}</CommandGroupLabel>
                {pages.map((item) => (
                  <CommandItem
                    key={item.page}
                    value={`page:${item.page}`}
                    label={item.label}
                    keywords={[app]}
                  >
                    <item.icon />
                    {item.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup>
              <CommandGroupLabel>Apps</CommandGroupLabel>
              {apps.map((a) => (
                <CommandItem
                  key={a.app.name}
                  value={`app:${a.app.name}`}
                  label={a.app.name}
                  keywords={a.app.description ? [a.app.description] : []}
                >
                  <AppMark name={a.app.name} className="size-4 text-[9px]" />
                  {a.app.name}
                  {a.app.description && (
                    <span className="truncate text-xs text-subtle">{a.app.description}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup>
              <CommandGroupLabel>Platform</CommandGroupLabel>
              <CommandItem value="go:/" label="All apps">
                <Boxes />
                All apps
              </CommandItem>
              {isAdmin && (
                <CommandItem value="go:/platform" label="Platform" keywords={['members', 'cost', 'edge']}>
                  <Shield />
                  Platform
                </CommandItem>
              )}
            </CommandGroup>
            {app && (
              <CommandGroup>
                <CommandGroupLabel>Time range</CommandGroupLabel>
                {RANGE_PRESETS.map((p) => (
                  <CommandItem
                    key={p.value}
                    value={`time:${p.value}`}
                    label={p.label}
                    keywords={['time', p.value]}
                  >
                    <Clock />
                    {p.label}
                    <CommandShortcut className="font-mono">{p.value}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup>
              <CommandGroupLabel>Theme</CommandGroupLabel>
              <CommandItem value="theme:system" label="Use system theme" keywords={['theme', 'appearance']}>
                <Monitor />
                Use system theme
              </CommandItem>
              <CommandItem value="theme:light" label="Light theme" keywords={['theme', 'appearance']}>
                <Sun />
                Light theme
              </CommandItem>
              <CommandItem value="theme:dark" label="Dark theme" keywords={['theme', 'appearance']}>
                <Moon />
                Dark theme
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
