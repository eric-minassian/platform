/** One choice out of a few, shown side by side (chart kind, scale, mode). */
import type { ReactNode } from 'react';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.tsx';

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ readonly value: T; readonly label: ReactNode }>;
  /** The group's accessible name. */
  label: string;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next) => {
        const picked = next[0] as T | undefined;
        if (picked !== undefined) onChange(picked);
      }}
      variant="outline"
      size="sm"
      spacing={0}
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          className="px-2.5 text-xs text-muted-foreground aria-pressed:bg-foreground/10 aria-pressed:text-foreground"
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
