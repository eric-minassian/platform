/**
 * The sidebar: inside an app, its pages grouped by what they're for, under
 * a switcher for the app and its stage; elsewhere, the platform's own pages.
 * Folds to icons (⌘B) to give wide pages room.
 */
import { useAtomValue } from '@effect/atom-react';
import type { MeResponse } from '@ericminassian/platform-core';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { Boxes, Check, ChevronsUpDown, LayoutGrid, LogOut, Shield } from 'lucide-react';
import { useState } from 'react';
import { appsAtom } from '../../data/atoms.ts';
import { stageOf, useAppSummary, useLiveManifest } from '../../data/hooks.ts';
import { useAppName, useStage } from '../../lib/hooks.ts';
import { cn } from '../../lib/utils.ts';
import { StatusDot, statusTone } from '../page.tsx';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar.tsx';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '../ui/command.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '../ui/sidebar.tsx';
import { APP_NAV, appPath } from './nav.ts';

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-block size-4 shrink-0 rounded-[4px] border-[1.5px] border-foreground',
        className,
      )}
    >
      <span className="absolute top-[2.5px] left-[2.5px] size-[7px] rounded-[1.5px] bg-foreground" />
    </span>
  );
}

export function AppSidebar({ me, onSignOut }: { me: MeResponse; onSignOut: () => void }) {
  const app = useAppName();
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-3 px-2 pt-3">
        <Link to="/" className="flex h-7 items-center gap-2.5 px-2 font-semibold tracking-tight">
          <BrandMark />
          <span className="group-data-[collapsible=icon]:hidden">platform</span>
        </Link>
        {app && <ScopeSwitcher app={app} />}
      </SidebarHeader>
      <SidebarContent>{app ? <AppNav app={app} /> : <PlatformNav me={me} />}</SidebarContent>
      <SidebarFooter>
        {app && <PlatformLinks me={me} />}
        <UserMenu me={me} onSignOut={onSignOut} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function usePathname(): string {
  return useRouterState({ select: (s) => s.location.pathname });
}

function PlatformNav({ me }: { me: MeResponse }) {
  const path = usePathname();
  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={path === '/'} tooltip="Apps" render={<Link to="/" />}>
              <Boxes />
              <span>Apps</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={path.startsWith('/dashboards')}
              tooltip="Dashboards"
              render={<Link to="/dashboards" />}
            >
              <LayoutGrid />
              <span>Dashboards</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {me.role === 'admin' && (
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={path === '/platform'}
                tooltip="Platform"
                render={<Link to="/platform" />}
              >
                <Shield />
                <span>Platform</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function PlatformLinks({ me }: { me: MeResponse }) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip="All apps" render={<Link to="/" />}>
          <Boxes />
          <span>All apps</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip="All dashboards" render={<Link to="/dashboards" />}>
          <LayoutGrid />
          <span>All dashboards</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      {me.role === 'admin' && (
        <SidebarMenuItem>
          <SidebarMenuButton tooltip="Platform" render={<Link to="/platform" />}>
            <Shield />
            <span>Platform</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
    </SidebarMenu>
  );
}

function AppNav({ app }: { app: string }) {
  const stage = useStage();
  const path = usePathname();
  const manifest = useLiveManifest(app, stage);
  const summary = Option.getOrUndefined(AsyncResult.value(useAppSummary(app)));
  const alarms = summary?.alerts?.alarm ?? 0;
  return (
    <>
      {APP_NAV.map((group) => {
        const items = group.items.filter((item) => !item.when || !manifest || item.when(manifest));
        if (items.length === 0) return null;
        return (
          <SidebarGroup key={group.label ?? 'top'} className="py-1">
            {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((item) => {
                  const href = appPath(app, item.page);
                  const active =
                    item.page === '/apps/$app' ? path === href || path === `${href}/` : path.startsWith(href);
                  return (
                    <SidebarMenuItem key={item.page}>
                      <SidebarMenuButton
                        isActive={active}
                        tooltip={item.label}
                        render={<Link to={item.page} params={{ app }} />}
                      >
                        <item.icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                      {item.page === '/apps/$app/alerts' && alarms > 0 && (
                        <SidebarMenuBadge className="text-bad" aria-label={`${alarms} firing`}>
                          {alarms}
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        );
      })}
    </>
  );
}

/** Picks the app (any app, landing on the same page) and its stage. */
function ScopeSwitcher({ app }: { app: string }) {
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
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${app}, ${stage}: switch app or stage`}
            className="flex w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-left text-sm outline-none group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <span className="grid size-5 shrink-0 place-items-center rounded bg-[#1b2a3f] text-[11px] font-semibold text-[#9ec5f4] uppercase">
          {app.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium group-data-[collapsible=icon]:hidden">
          {app}
        </span>
        <span className="flex items-center gap-1.5 rounded-full border px-1.5 font-mono text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden">
          <StatusDot tone={current ? statusTone(current.status) : 'muted'} className="size-1.5" />
          {stage}
        </span>
        <ChevronsUpDown className="size-3.5 text-muted-foreground group-data-[collapsible=icon]:hidden" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Find an app or stage" />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            {stages.length > 0 && (
              <CommandGroup heading={`${app} stages`}>
                {stages.map((s) => (
                  <CommandItem key={s.stage} value={`stage ${s.stage}`} onSelect={() => go(app, s.stage)}>
                    <StatusDot tone={statusTone(s.status)} />
                    <span className="font-mono text-[13px]">{s.stage}</span>
                    {s.preview && <span className="text-xs text-muted-foreground">preview</span>}
                    {s.stage === stage && <Check className="ml-auto" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandSeparator />
            <CommandGroup heading="Apps">
              {apps.map((a) => (
                <CommandItem
                  key={a.app.name}
                  value={`app ${a.app.name}`}
                  onSelect={() => go(a.app.name, 'prod')}
                >
                  <span className="grid size-4 place-items-center rounded-sm bg-[#1b2a3f] text-[10px] font-semibold text-[#9ec5f4] uppercase">
                    {a.app.name.slice(0, 1)}
                  </span>
                  {a.app.name}
                  {a.app.name === app && <Check className="ml-auto" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function UserMenu({ me, onSignOut }: { me: MeResponse; onSignOut: () => void }) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="h-10" />}>
            <Avatar className="size-6 rounded-md">
              <AvatarImage src={`https://github.com/${encodeURIComponent(me.github)}.png?size=48`} alt="" />
              <AvatarFallback className="rounded-md text-[11px] uppercase">
                {me.github.slice(0, 2)}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate text-left">
              <span className="block truncate text-sm">{me.github}</span>
              <span className="block text-xs text-muted-foreground">{me.role}</span>
            </span>
            <ChevronsUpDown className="size-3.5 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuLabel>Signed in as {me.github}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onSignOut}>
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
