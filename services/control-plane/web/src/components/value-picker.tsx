/**
 * Picks several values from a searchable list (routes, jobs, metric names…),
 * as the explorer's and the traces page's filters use it: a button showing
 * what's picked, opening a list with its search field inside.
 */
import {
  Combobox,
  ComboboxContent,
  ComboboxCreate,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
  ComboboxTrigger,
} from '@ui-sdk/react/combobox';
import { Check, ChevronsUpDown, Plus, Search } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '../lib/utils.ts';
import { buttonVariants } from './ui/button.tsx';
import { listItem, popupSurface } from './ui/surface.ts';

export interface PickerOption {
  readonly value: string;
  /** Shown at the right, e.g. a count. */
  readonly hint?: ReactNode;
}

export function ValuePicker({
  label,
  name,
  options,
  selected,
  onChange,
  placeholder = 'Search',
  allowCustom = false,
  className,
}: {
  /** The trigger's text when nothing is picked, e.g. "All routes". */
  label: string;
  /** What it picks, e.g. "Routes": the list's name, and the trigger's once something is picked. */
  name: string;
  options: readonly PickerOption[];
  selected: readonly string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  /** Lets a typed value that isn't listed be picked (values the range hasn't seen yet). */
  allowCustom?: boolean;
  className?: string;
}) {
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const summary =
    selected.length === 0
      ? label
      : selected.length === 1
        ? selected[0]!
        : `${selected[0]} +${selected.length - 1}`;
  // Picked values the range didn't report still show, checked, so they can be unpicked.
  const items = [
    ...options,
    ...selected.filter((v) => !options.some((o) => o.value === v)).map((value): PickerOption => ({ value })),
  ];
  return (
    <Combobox
      multiple
      value={[...selected]}
      onValueChange={onChange}
      query={query}
      onQueryChange={setQuery}
      onOpenChange={(open) => open && setQuery('')}
      onOpenChangeComplete={(open) => (open ? input : button)?.focus()}
    >
      <ComboboxTrigger
        ref={setButton}
        aria-label={selected.length ? `${name}: ${selected.join(', ')}` : label}
        className={cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          'max-w-72 justify-between gap-2 font-normal',
          selected.length === 0 && 'text-muted-foreground',
          className,
        )}
      >
        <span className={cn('truncate', selected.length > 0 && 'font-mono text-[12px]')}>{summary}</span>
        <ChevronsUpDown aria-hidden className="text-subtle" />
      </ComboboxTrigger>
      <ComboboxContent
        anchor={button}
        align="start"
        sideOffset={4}
        className={cn(popupSurface, 'flex max-h-(--available-height) w-80 flex-col p-0')}
      >
        <div className="flex shrink-0 items-center gap-2 border-b px-3">
          <Search aria-hidden className="size-3.5 shrink-0 text-subtle" />
          <ComboboxInput
            ref={setInput}
            aria-label={`Search ${name.toLowerCase()}`}
            placeholder={placeholder}
            className="h-9 min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] outline-hidden placeholder:text-subtle"
          />
        </div>
        <ComboboxList aria-label={name} className="min-h-0 overflow-y-auto p-1">
          {items.map((o) => (
            <ComboboxItem key={o.value} value={o.value} label={o.value} className={cn(listItem, 'group')}>
              <span
                aria-hidden
                className="grid size-4 shrink-0 place-items-center rounded-[4px] border border-border-strong bg-background group-data-selected:border-foreground group-data-selected:bg-foreground"
              >
                <ComboboxItemIndicator className="flex">
                  <Check className="size-3 text-background" strokeWidth={3} />
                </ComboboxItemIndicator>
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{o.value}</span>
              {o.hint !== undefined && (
                <span className="text-xs text-muted-foreground tabular">{o.hint}</span>
              )}
            </ComboboxItem>
          ))}
          {allowCustom && (
            <ComboboxCreate
              className={listItem}
              onCreate={(typed) => {
                const value = typed.trim();
                if (value && !selected.includes(value)) onChange([...selected, value]);
              }}
            >
              {(state) => (
                <>
                  <Plus aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    Add <span className="font-mono text-[12px]">{state.query.trim()}</span>
                  </span>
                </>
              )}
            </ComboboxCreate>
          )}
        </ComboboxList>
        {!(allowCustom && query.trim()) && (
          <ComboboxEmpty className="px-3 py-6 text-center text-[13px] text-muted-foreground not-data-empty:hidden">
            {allowCustom ? 'Type a value to add it.' : 'Nothing matches.'}
          </ComboboxEmpty>
        )}
      </ComboboxContent>
    </Combobox>
  );
}
