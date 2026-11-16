/**
 * Picks one or several values from a searchable list (routes, jobs, metric
 * names, levels…), as the explorer's and the log page's filters use it.
 */
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '../lib/utils.ts';
import { Button } from './ui/button.tsx';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx';

export interface PickerOption {
  readonly value: string;
  readonly label?: ReactNode;
  /** Shown at the right, e.g. a count. */
  readonly hint?: ReactNode;
}

export function ValuePicker({
  label,
  options,
  selected,
  onChange,
  multiple = true,
  placeholder = 'Search',
  allowCustom = false,
  className,
  trigger,
}: {
  /** The trigger's text when nothing is picked, and the list's accessible name. */
  label: string;
  options: readonly PickerOption[];
  selected: readonly string[];
  onChange: (values: string[]) => void;
  multiple?: boolean;
  placeholder?: string;
  /** Lets a typed value that isn't listed be picked (values the range hasn't seen yet). */
  allowCustom?: boolean;
  className?: string;
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const toggle = (value: string) => {
    if (!multiple) {
      onChange(selected.includes(value) ? [] : [value]);
      setOpen(false);
      return;
    }
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };
  const typed = query.trim();
  const known = options.some((o) => o.value === typed) || selected.includes(typed);
  const summary =
    selected.length === 0
      ? label
      : selected.length === 1
        ? selected[0]
        : `${selected[0]} +${selected.length - 1}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          trigger ? (
            <Button variant="outline" size="sm" className={cn('font-normal', className)} />
          ) : (
            <Button
              variant="outline"
              size="sm"
              className={cn(
                'max-w-72 justify-between gap-2 font-normal',
                selected.length === 0 && 'text-muted-foreground',
                className,
              )}
            />
          )
        }
      >
        {trigger ?? (
          <>
            <span className="truncate font-mono text-[12px]">{summary}</span>
            <ChevronsUpDown className="text-muted-foreground" />
          </>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command>
          <CommandInput placeholder={placeholder} value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>
              {allowCustom && typed ? 'Press Enter to add it.' : 'Nothing matches.'}
            </CommandEmpty>
            <CommandGroup heading={label}>
              {allowCustom && typed && !known && (
                <CommandItem
                  value={`custom ${typed}`}
                  onSelect={() => {
                    toggle(typed);
                    setQuery('');
                  }}
                >
                  <Plus />
                  <span className="truncate font-mono text-[12px]">{typed}</span>
                </CommandItem>
              )}
              {[
                ...options,
                ...selected.filter((v) => !options.some((o) => o.value === v)).map((value) => ({ value })),
              ].map((o) => (
                <CommandItem key={o.value} value={o.value} onSelect={() => toggle(o.value)}>
                  <Check className={cn(!selected.includes(o.value) && 'invisible')} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                    {'label' in o && o.label ? o.label : o.value}
                  </span>
                  {'hint' in o && o.hint !== undefined && (
                    <span className="text-xs text-muted-foreground tabular">{o.hint}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
