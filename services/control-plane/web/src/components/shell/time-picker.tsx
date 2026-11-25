/**
 * The page's time window: presets, a custom range, UTC display, zoom out,
 * and how often a moving window refreshes.
 */
import { Listbox, ListboxItem, ListboxItemIndicator } from '@ui-sdk/react/listbox';
import { Check, ChevronDown, Clock, RefreshCw, X, ZoomOut } from 'lucide-react';
import { useState } from 'react';
import { useTime } from '../../lib/hooks.ts';
import { REFRESH_INTERVALS, usePrefs } from '../../lib/prefs.tsx';
import { DEFAULT_RANGE, describeTime, RANGE_PRESETS, zoomOut } from '../../lib/time.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { Field, FieldLabel } from '../ui/field.tsx';
import { Input } from '../ui/input.tsx';
import { Label } from '../ui/label.tsx';
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from '../ui/menu.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Separator } from '../ui/separator.tsx';
import { listItem } from '../ui/surface.ts';
import { Switch } from '../ui/switch.tsx';
import { Tip } from '../ui/tooltip.tsx';

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
  const current = time.search.range ?? (absolute ? null : DEFAULT_RANGE);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const customFrom = fromInput(from, utc);
  const customTo = fromInput(to, utc);
  const customValid = Number.isFinite(customFrom) && Number.isFinite(customTo) && customFrom < customTo;

  return (
    <div className="flex items-center gap-1.5">
      {absolute && (
        <>
          <Tip label="Zoom out">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom out"
              onClick={() => time.set(zoomOut(time.window))}
            >
              <ZoomOut />
            </Button>
          </Tip>
          <Tip label="Back to the last 24 hours">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back to the last 24 hours"
              onClick={() => time.set({ range: DEFAULT_RANGE })}
            >
              <X />
            </Button>
          </Tip>
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
        <PopoverTrigger
          aria-label={`Time range: ${describeTime(time.search, utc)}`}
          className={cn(
            'inline-flex h-7 cursor-default items-center gap-2 rounded-md border border-border-strong bg-background px-2.5 text-[13px] outline-hidden hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring data-open:bg-accent',
          )}
        >
          <Clock className="size-3.5 text-muted-foreground" />
          <span className="tabular">{describeTime(time.search, utc)}</span>
          <ChevronDown className="size-3.5 text-subtle" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-76 p-1.5">
          <Listbox
            aria-label="Time range"
            activation="manual"
            value={current}
            onValueChange={(next) => {
              if (typeof next === 'string') {
                time.set({ range: next });
                setOpen(false);
              }
            }}
            className="flex flex-col outline-hidden"
          >
            {RANGE_PRESETS.map((p) => (
              <ListboxItem key={p.value} value={p.value} label={p.label} className={cn(listItem, 'pl-8')}>
                <ListboxItemIndicator className="absolute left-2 flex items-center">
                  <Check aria-hidden className="size-3.5 text-foreground" />
                </ListboxItemIndicator>
                <span className="text-foreground">{p.label}</span>
                <span className="ml-auto font-mono text-xs text-subtle">{p.value}</span>
              </ListboxItem>
            ))}
          </Listbox>
          <Separator className="my-1.5" />
          <form
            className="grid gap-2.5 p-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!customValid) return;
              time.zoom(customFrom, customTo);
              setOpen(false);
            }}
          >
            <p className="text-xs font-medium text-subtle">Custom range{utc ? ' (UTC)' : ''}</p>
            <Field>
              <FieldLabel className="text-xs text-muted-foreground">From</FieldLabel>
              <Input size="sm" type="datetime-local" value={from} onValueChange={setFrom} />
            </Field>
            <Field>
              <FieldLabel className="text-xs text-muted-foreground">To</FieldLabel>
              <Input size="sm" type="datetime-local" value={to} onValueChange={setTo} />
            </Field>
            <Button type="submit" size="sm" disabled={!customValid}>
              Apply range
            </Button>
          </form>
          <Separator className="my-1.5" />
          <div className="flex items-center justify-between px-2 py-1.5">
            <Label htmlFor="time-utc" className="font-normal">
              Show times in UTC
            </Label>
            <Switch
              id="time-utc"
              size="sm"
              checked={utc}
              onCheckedChange={(checked) => setPrefs({ utc: checked })}
            />
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
      <Tip label="Refresh now">
        <Button
          variant="outline"
          size="icon-sm"
          className="rounded-r-none"
          aria-label="Refresh now"
          onClick={refreshNow}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </Tip>
      <Menu>
        <MenuTrigger
          aria-label="Auto-refresh interval"
          className="-ml-px inline-flex h-7 cursor-default items-center gap-1 rounded-r-md border border-border-strong bg-background px-2 text-[13px] tabular outline-hidden hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid data-open:bg-accent"
        >
          <span className={cn(!live && 'text-muted-foreground')}>{live ? label : 'Paused'}</span>
          <ChevronDown className="size-3.5 text-subtle" />
        </MenuTrigger>
        <MenuContent align="end" className="w-52">
          <MenuGroup>
            <MenuGroupLabel>Auto-refresh</MenuGroupLabel>
            {!live && (
              <p className="px-2 pb-1.5 text-xs text-muted-foreground">A fixed window doesn't change.</p>
            )}
            <MenuRadioGroup value={String(refreshMs)} onValueChange={(v) => set({ refreshMs: Number(v) })}>
              {REFRESH_INTERVALS.map((r) => (
                <MenuRadioItem key={r.value} value={String(r.value)}>
                  {r.label === 'Off' ? 'Off' : `Every ${r.label}`}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </MenuContent>
      </Menu>
    </div>
  );
}
