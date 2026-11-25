import {
  SegmentedControlIndicator,
  SegmentedControlItem,
  SegmentedControl as SegmentedControlPart,
} from '@ui-sdk/react/segmented-control';
import { cn } from 'cn';
import type { ReactNode } from 'react';

/** One choice out of a few, side by side, with a marker that slides to the choice. */
function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'sm',
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<{ readonly value: T; readonly label: ReactNode; readonly title?: string }>;
  /** The group's accessible name. */
  label: string;
  size?: 'xs' | 'sm' | 'default';
  className?: string;
}) {
  return (
    <SegmentedControlPart
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      className={cn(
        'relative inline-flex shrink-0 items-stretch rounded-md border border-border-strong bg-muted p-0.5',
        size === 'xs' && 'h-6',
        size === 'sm' && 'h-7',
        size === 'default' && 'h-8',
        className,
      )}
    >
      <SegmentedControlIndicator className="absolute top-(--segmented-control-indicator-top) left-(--segmented-control-indicator-left) h-(--segmented-control-indicator-height) w-(--segmented-control-indicator-width) rounded-[4px] bg-background shadow-[0_0_0_1px_var(--border-strong),0_1px_2px_rgb(0_0_0/0.06)] transition-[left,width] duration-200 motion-reduce:transition-none" />
      {options.map((o) => (
        <SegmentedControlItem
          key={o.value}
          value={o.value}
          title={o.title}
          className={cn(
            'relative z-10 inline-flex cursor-default items-center justify-center gap-1.5 rounded-[4px] px-2.5 font-medium whitespace-nowrap text-muted-foreground outline-hidden select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring data-checked:text-foreground [&_svg]:size-3.5',
            size === 'xs' ? 'px-2 text-xs' : 'text-[13px]',
          )}
        >
          {o.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControlPart>
  );
}

export { Segmented };
