/**
 * The page's time window: presets, a custom range, UTC display, zoom out,
 * and how often a moving window refreshes.
 */
import { Check, ChevronDown, Clock, RefreshCw, X, ZoomOut } from 'lucide-react';
import { useState } from 'react';
import { useTime } from '../../lib/hooks.ts';
import { REFRESH_INTERVALS, usePrefs } from '../../lib/prefs.tsx';
import { DEFAULT_RANGE, describeTime, RANGE_PRESETS, zoomOut } from '../../lib/time.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx';
import { Input } from '../ui/input.tsx';
import { Label } from '../ui/label.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Separator } from '../ui/separator.tsx';
import { Switch } from '../ui/switch.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.tsx';

/** `datetime-local` value for an instant, in local time or UTC. */
function toInput(ms: number, utc: boolean): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const [y, mo, da, h, mi] = utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
  return `${y}-${pad(mo)}-${pad(da)}T${pad(h)}:${pad(mi)}`;
}

function fromInput(value: string, utc: boolean): number {
  return Date.parse(utc ? `${value}:00Z` : value);
}

export function TimePicker() {
  const time = useTime();
  const { utc, set: setPrefs } = usePrefs();
  const [open, setOpen] = useState(false);
  const absolute = time.search.from !== undefined;
  const current = time.search.range ?? (absolute ? undefined : DEFAULT_RANGE);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const customFrom = fromInput(from, utc);
  const customTo = fromInput(to, utc);
  const customValid = Number.isFinite(customFrom) && Number.isFinite(customTo) && customFrom < customTo;

  return (
    <div className="flex items-center gap-1">
      {absolute && (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Zoom out"
                  onClick={() => time.set(zoomOut(time.window))}
                />
              }
            >
              <ZoomOut />
            </TooltipTrigger>
            <TooltipContent>Zoom out</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Back to the last 24 hours"
                  onClick={() => time.set({ range: DEFAULT_RANGE })}
                />
              }
            >
              <X />
            </TooltipTrigger>
            <TooltipContent>Back to the last 24 hours</TooltipContent>
          </Tooltip>
        </>
      )}
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setFrom(toInput(time.window.from, utc));
            setTo(toInput(time.window.to, utc));
          }
          setOpen(next);
        }}
      >
        <PopoverTrigger render={<Button variant="outline" size="sm" className="gap-2 font-normal" />}>
          <Clock className="text-muted-foreground" />
          <span className="tabular">{describeTime(time.search, utc)}</span>
          <ChevronDown className="text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-1.5">
          <div aria-label="Time range" className="flex flex-col">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                aria-pressed={current === p.value}
                onClick={() => {
                  time.set({ range: p.value });
                  setOpen(false);
                }}
                className={cn(
                  'flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent',
                  current === p.value ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                <Check className={cn('size-4', current !== p.value && 'invisible')} strokeWidth={2.5} />
                {p.label}
                <span className="ml-auto font-mono text-xs text-muted-foreground">{p.value}</span>
              </button>
            ))}
          </div>
          <Separator className="my-1.5" />
          <form
            className="grid gap-2 p-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!customValid) return;
              time.zoom(customFrom, customTo);
              setOpen(false);
            }}
          >
            <p className="text-xs font-medium text-muted-foreground">Custom range{utc ? ' (UTC)' : ''}</p>
            <div className="grid gap-1">
              <Label htmlFor="time-from" className="text-xs text-muted-foreground">
                From
              </Label>
              <Input
                id="time-from"
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="time-to" className="text-xs text-muted-foreground">
                To
              </Label>
              <Input id="time-to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <Button type="submit" size="sm" disabled={!customValid}>
              Apply range
            </Button>
          </form>
          <Separator className="my-1.5" />
          <div className="flex items-center justify-between px-2 py-1.5">
            <Label htmlFor="time-utc" className="text-sm font-normal">
              Show times in UTC
            </Label>
            <Switch id="time-utc" checked={utc} onCheckedChange={(checked) => setPrefs({ utc: checked })} />
          </div>
        </PopoverContent>
      </Popover>
      <RefreshControl live={!absolute} />
    </div>
  );
}

function RefreshControl({ live }: { live: boolean }) {
  const { refreshMs, set, refreshNow } = usePrefs();
  const label = REFRESH_INTERVALS.find((r) => r.value === refreshMs)?.label ?? 'Off';
  return (
    <div className="flex items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="icon-sm"
              className="rounded-r-none"
              aria-label="Refresh now"
              onClick={refreshNow}
            />
          }
        >
          <RefreshCw />
        </TooltipTrigger>
        <TooltipContent>Refresh now</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="-ml-px rounded-l-none px-2 font-normal tabular"
              aria-label="Auto-refresh interval"
            />
          }
        >
          <span className={cn(!live && 'text-muted-foreground')}>{live ? label : 'Paused'}</span>
          <ChevronDown className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel>Auto-refresh</DropdownMenuLabel>
          {!live && (
            <p className="px-2 pb-1.5 text-xs text-muted-foreground">A fixed window doesn't change.</p>
          )}
          <DropdownMenuRadioGroup
            value={String(refreshMs)}
            onValueChange={(v) => set({ refreshMs: Number(v) })}
          >
            {REFRESH_INTERVALS.map((r) => (
              <DropdownMenuRadioItem key={r.value} value={String(r.value)}>
                {r.label === 'Off' ? 'Off' : `Every ${r.label}`}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
