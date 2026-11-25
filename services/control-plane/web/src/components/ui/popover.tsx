import {
  PopoverClose,
  PopoverContent as PopoverContentPart,
  PopoverDescription as PopoverDescriptionPart,
  Popover,
  PopoverTitle as PopoverTitlePart,
  PopoverTrigger,
} from '@ui-sdk/react/popover';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

type Styled<P> = Omit<P, 'className'> & { className?: string };

function PopoverContent({
  className,
  sideOffset = 6,
  ...props
}: Styled<ComponentProps<typeof PopoverContentPart>>) {
  return (
    <PopoverContentPart
      sideOffset={sideOffset}
      className={cn(
        'm-0 max-h-(--available-height) w-72 overflow-y-auto rounded-xl bg-popover p-3 text-sm text-foreground shadow-popover outline-hidden popup-motion',
        className,
      )}
      {...props}
    />
  );
}

function PopoverTitle({ className, ...props }: Styled<ComponentProps<typeof PopoverTitlePart>>) {
  return <PopoverTitlePart className={cn('m-0 text-sm font-semibold', className)} {...props} />;
}

function PopoverDescription({ className, ...props }: Styled<ComponentProps<typeof PopoverDescriptionPart>>) {
  return (
    <PopoverDescriptionPart className={cn('m-0 text-[13px] text-muted-foreground', className)} {...props} />
  );
}

export { Popover, PopoverClose, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger };
