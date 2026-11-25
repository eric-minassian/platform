/**
 * The sidebar: inside an app, its pages grouped by what they're for, under a
 * switcher for the app and its stage; elsewhere, the platform's own pages.
 * Folds to icons (⌘B) to give wide pages room.
 */
import { useAtomValue } from '@effect/atom-react';
import type { MeResponse } from '@ericminassian/platform-core';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { usePreference } from '@ui-sdk/react/preferences';
import { useShortcutHint } from '@ui-sdk/react/shortcuts';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { Boxes, Check, ChevronsUpDown, LogOut, PanelLeft, Search, Shield } from 'lucide-react';
import { useState } from 'react';
import { appsAtom } from '../../data/atoms.ts';
import { stageOf, useAppSummary, useLiveManifest } from '../../data/hooks.ts';
import { colorScheme } from '../../lib/color-scheme.ts';
import { useAppName, useStage } from '../../lib/hooks.ts';
import { cn } from '../../lib/utils.ts';
import { StatusDot, statusTone } from '../page.tsx';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar.tsx';
import { Button } from '../ui/button.tsx';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '../ui/command.tsx';
import { Kbd } from '../ui/kbd.tsx';
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '../ui/menu.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Tip } from '../ui/tooltip.tsx';
import { APP_NAV, isCurrent } from './nav.ts';

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={cn('size-5 shrink-0', className)}>
      <rect
        x="0.75"
        y="0.75"
        width="14.5"
        height="14.5"
        rx="3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />
    </svg>
  );
}

/** An app's mark: its first letter on a tint picked from its name, so apps tell apart at a glance. */
export function AppMark({ name, className }: { name: string; className?: string }) {
  const hues = [217, 262, 160, 24, 330, 190];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = hues[h % hues.length] ?? 217;
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded-[5px] text-[11px] font-semibold text-white uppercase',
        className,
      )}
      style={{ background: `linear-gradient(135deg, oklch(0.62 0.17 ${hue}), oklch(0.5 0.19 ${hue + 40}))` }}
    >
      {name.slice(0, 1)}
    </span>
  );
}

const navItem =
  'flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground [&>svg]:size-4 [&>svg]:shrink-0';

export function Sidebar({
  me,
  folded,
  onFold,
  onSearch,
  onSignOut,
}: {
  me: MeResponse;
  folded: boolean;
  /** Folds or unfolds; absent where the sidebar can't fold, like the phone drawer. */
  onFold?: () => void;
  onSearch: () => void;
  onSignOut: () => void;
}) {
  const app = useAppName();
  const searchHint = useShortcutHint('mod+k');
  return (
    <div className={cn('flex h-full min-h-0 flex-col gap-1 px-2.5 py-3', folded && 'items-center px-2')}>
      <div className={cn('flex h-8 items-center gap-2 px-1.5', folded && 'px-0')}>
        <Link
          to="/"
          aria-label="platform, all apps"
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight outline-hidden focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
        >
          <BrandMark />
          {!folded && <span>platform</span>}
        </Link>
        {onFold && !folded && (
          <Tip label="Fold sidebar" shortcut="mod+b">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Fold sidebar"
              onClick={onFold}
              className="ml-auto text-subtle"
            >
              <PanelLeft />
            </Button>
          </Tip>
        )}
      </div>
      <div className={cn('mt-2 mb-1 flex flex-col gap-1.5', folded && 'items-center')}>
        {app && <ScopeSwitcher app={app} folded={folded} />}
        {folded ? (
          <Tip label="Search" shortcut="mod+k" side="right">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Search"
              onClick={onSearch}
              className="text-muted-foreground"
            >
              <Search />
            </Button>
          </Tip>
        ) : (
          <Button
            variant="outline"
            onClick={onSearch}
            aria-keyshortcuts={searchHint.ariaKeyshortcuts}
            className="justify-start gap-2 border-border px-2 font-normal text-subtle shadow-none hover:border-border-strong hover:bg-background hover:text-muted-foreground"
          >
            <Search />
            <span className="flex-1 text-left">Find…</span>
            <Kbd aria-hidden="true">{searchHint.text}</Kbd>
          </Button>
        )}
      </div>
      <nav
        aria-label={app ? `${app} pages` : 'Platform'}
        className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1"
      >
        {app ? <AppNav app={app} folded={folded} /> : <PlatformNav me={me} folded={folded} />}
      </nav>
      {folded && onFold && (
        <Tip label="Unfold sidebar" shortcut="mod+b" side="right">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Unfold sidebar"
            onClick={onFold}
            className="text-muted-foreground"
          >
            <PanelLeft />
          </Button>
        </Tip>
      )}
      <UserMenu me={me} folded={folded} onSignOut={onSignOut} />
    </div>
  );
}

function usePathname(): string {
  return useRouterState({ select: (s) => s.location.pathname });
}

function NavLink({
  to,
  params,
  label,
  icon: Icon,
  current,
  folded,
  badge,
}: {
  to: string;
  params?: Record<string, string>;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  current: boolean;
  folded: boolean;
  badge?: React.ReactNode;
}) {
  const link = (
    <Link
      to={to as never}
      params={params as never}
      // The router marks prefix matches active too; which item is current is decided here.
      activeOptions={{ exact: true, includeSearch: false }}
      aria-current={current ? 'page' : undefined}
      aria-label={folded ? label : undefined}
      className={cn(navItem, folded && 'relative size-8 justify-center px-0')}
    >
      <Icon />
      {!folded && <span className="truncate">{label}</span>}
      {badge && <span className={cn(folded ? 'absolute -top-0.5 -right-0.5' : 'ml-auto')}>{badge}</span>}
    </Link>
  );
  return folded ? (
    <Tip label={label} side="right">
      {link}
    </Tip>
  ) : (
    link
  );
}

function PlatformNav({ me, folded }: { me: MeResponse; folded: boolean }) {
  const path = usePathname();
  return (
    <ul className={cn('flex flex-col gap-0.5', folded && 'items-center')}>
      <li>
        <NavLink to="/" label="Apps" icon={Boxes} current={path === '/'} folded={folded} />
      </li>
      {me.role === 'admin' && (
        <li>
          <NavLink
            to="/platform"
            label="Platform"
            icon={Shield}
            current={path === '/platform'}
            folded={folded}
          />
        </li>
      )}
    </ul>
  );
}

function AppNav({ app, folded }: { app: string; folded: boolean }) {
  const stage = useStage();
  const path = usePathname();
  const manifest = useLiveManifest(app, stage);
  const summary = Option.getOrUndefined(AsyncResult.value(useAppSummary(app)));
  const alarms = summary?.alerts?.alarm ?? 0;
  return (
    <div className="flex flex-col gap-3">
      {APP_NAV.map((group) => {
        const items = group.items.filter((item) => !item.when || !manifest || item.when(manifest));
        if (items.length === 0) return null;
        return (
          <section key={group.label ?? 'top'} aria-label={group.label}>
            {group.label &&
              (folded ? (
                <div aria-hidden className="mx-auto mb-1.5 h-px w-5 bg-border" />
              ) : (
                <h2 className="px-2 pb-1 text-xs font-medium text-subtle">{group.label}</h2>
              ))}
            <ul className={cn('flex flex-col gap-0.5', folded && 'items-center')}>
              {items.map((item) => (
                <li key={item.page}>
                  <NavLink
                    to={item.page}
                    params={{ app }}
                    label={item.label}
                    icon={item.icon}
                    current={isCurrent(path, app, item.page)}
                    folded={folded}
                    badge={
                      item.page === '/apps/$app/alerts' && alarms > 0 ? (
                        <span
                          className={cn(
                            'grid h-[18px] min-w-[18px] place-items-center rounded-full bg-bad-mark/15 px-1 text-[11px] font-semibold text-bad tabular',
                            folded && 'h-4 min-w-4 bg-bad-mark text-[10px] text-white',
                          )}
                        >
                          <span aria-hidden>{alarms}</span>
                          <span className="sr-only">, {alarms} firing</span>
                        </span>
                      ) : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Picks the app (any app, landing on the same page) and its stage. */
function ScopeSwitcher({ app, folded }: { app: string; folded: boolean }) {
  const stage = useStage();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const apps = Option.getOrElse(AsyncResult.value(useAtomValue(appsAtom)), () => []);
  const summary = Option.getOrUndefined(AsyncResult.value(useAppSummary(app)));
  const current = stageOf(summary, stage);
  const stages = summary?.stages.filter((s) => s.status !== 'destroyed') ?? [];
  const path = usePathname();
  const rest = path.slice(`/apps/${encodeURIComponent(app)}`.length);
  const go = (nextApp: string, nextStage: string) => {
    setOpen(false);
    void navigate({
      to: `/apps/${encodeURIComponent(nextApp)}${nextApp === app ? rest : ''}`,
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        stage: nextStage === 'prod' ? undefined : nextStage,
      }),
    } as never);
  };
  const trigger = (
    <PopoverTrigger
      aria-label={`${app}, ${stage}: switch app or stage`}
      className={cn(
        'flex w-full cursor-default items-center gap-2 rounded-lg border bg-background px-2 text-left text-sm outline-hidden hover:border-border-strong focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring data-open:border-border-strong',
        folded ? 'size-8 justify-center border-0 bg-transparent p-0 hover:bg-accent' : 'h-10',
      )}
    >
      <AppMark name={app} />
      {!folded && (
        <>
          <span className="min-w-0 flex-1 truncate font-medium">{app}</span>
          <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <StatusDot tone={current ? statusTone(current.status) : 'muted'} className="size-1.5" />
            {stage}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-subtle" />
        </>
      )}
    </PopoverTrigger>
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {folded ? (
        <Tip label={`${app} · ${stage}`} side="right">
          {trigger}
        </Tip>
      ) : (
        trigger
      )}
      <PopoverContent align="start" side={folded ? 'right' : 'bottom'} className="w-72 p-0">
        <Command
          onAction={(value) => {
            const [kind, name] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)];
            if (kind === 'stage') go(app, name);
            else if (kind === 'app') go(name, 'prod');
            else {
              setOpen(false);
              void navigate({ to: '/' });
            }
          }}
        >
          <CommandInput
            aria-label="Find an app or stage"
            placeholder="Find an app or stage…"
            className="h-10 text-sm"
          />
          <CommandEmpty className="py-6">No match.</CommandEmpty>
          <CommandList className="max-h-80">
            {stages.length > 0 && (
              <CommandGroup>
                <CommandGroupLabel>{app} stages</CommandGroupLabel>
                {stages.map((s) => (
                  <CommandItem key={s.stage} value={`stage:${s.stage}`} label={`${s.stage} stage`}>
                    <StatusDot tone={statusTone(s.status)} />
                    <span className="font-mono text-[13px]">{s.stage}</span>
                    {s.preview && <span className="text-xs text-subtle">preview</span>}
                    {s.stage === stage && <Check className="ml-auto text-foreground" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandSeparator />
            <CommandGroup>
              <CommandGroupLabel>Apps</CommandGroupLabel>
              {apps.map((a) => (
                <CommandItem key={a.app.name} value={`app:${a.app.name}`} label={a.app.name}>
                  <AppMark name={a.app.name} className="size-4 text-[9px]" />
                  {a.app.name}
                  {a.app.name === app && <Check className="ml-auto text-foreground" />}
                </CommandItem>
              ))}
              <CommandItem value="all:apps" label="All apps">
                <Boxes />
                All apps
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function UserMenu({ me, folded, onSignOut }: { me: MeResponse; folded: boolean; onSignOut: () => void }) {
  const scheme = usePreference(colorScheme);
  const navigate = useNavigate();
  return (
    <Menu
      onAction={(value) => {
        if (value === 'sign-out') onSignOut();
        else if (value === 'platform') void navigate({ to: '/platform' });
        else if (value === 'apps') void navigate({ to: '/' });
      }}
    >
      <MenuTrigger
        aria-label={`Account: ${me.github}`}
        className={cn(
          'mt-1 flex cursor-default items-center gap-2.5 rounded-md text-left outline-hidden hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring data-open:bg-accent',
          folded ? 'size-8 justify-center' : 'h-11 w-full px-2',
        )}
      >
        <Avatar aria-hidden="true" className={cn(folded ? 'size-6' : 'size-7')}>
          <AvatarImage src={`https://github.com/${encodeURIComponent(me.github)}.png?size=56`} alt="" />
          <AvatarFallback>{me.github.slice(0, 2)}</AvatarFallback>
        </Avatar>
        {!folded && (
          <>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-medium">{me.github}</span>
              <span className="block text-xs text-subtle capitalize">{me.role}</span>
            </span>
            <ChevronsUpDown className="size-3.5 text-subtle" />
          </>
        )}
      </MenuTrigger>
      <MenuContent side={folded ? 'right' : 'top'} align="start" className="w-60">
        <div className="px-2 py-1.5 text-xs text-subtle">
          Signed in as <span className="font-medium text-foreground">{me.github}</span>
        </div>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Theme</MenuGroupLabel>
          <MenuRadioGroup name="theme" value={scheme.value} onValueChange={(next) => colorScheme.set(next)}>
            <MenuRadioItem value="system">System</MenuRadioItem>
            <MenuRadioItem value="light">Light</MenuRadioItem>
            <MenuRadioItem value="dark">Dark</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem value="apps">
          <Boxes />
          All apps
        </MenuItem>
        {me.role === 'admin' && (
          <MenuItem value="platform">
            <Shield />
            Platform
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem value="sign-out">
          <LogOut />
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
