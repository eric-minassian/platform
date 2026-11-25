import {
  TooltipContent as TooltipContentPart,
  Tooltip,
  TooltipShortcut,
  TooltipTrigger,
} from '@ui-sdk/react/tooltip';
import { cn } from 'cn';
import type { ComponentProps, ReactElement, ReactNode } from 'react';

function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: Omit<ComponentProps<typeof TooltipContentPart>, 'className'> & { className?: string }) {
  return (
    <TooltipContentPart
      sideOffset={sideOffset}
      className={cn(
        'm-0 max-w-72 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-pretty text-background shadow-popover popup-motion',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A short hint on an element. Pass the element itself as the trigger; it
 * keeps its own accessible name unless the hint is its only label.
 */
function Tip({
  label,
  children,
  side = 'top',
  shortcut,
  type,
}: {
  label: ReactNode;
  children: ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
  shortcut?: string;
  type?: 'label' | 'description';
}) {
  return (
    <Tooltip delay={400} shortcut={shortcut} type={type}>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>
        <span className="inline-flex items-center gap-2">
          {label}
          {shortcut && <TooltipShortcut className="text-background/60" />}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

export { Tip, Tooltip, TooltipContent, TooltipTrigger };
