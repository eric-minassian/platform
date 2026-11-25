import {
  SelectContent as SelectContentPart,
  SelectGroup,
  SelectGroupLabel as SelectGroupLabelPart,
  SelectItemIndicator,
  SelectItem as SelectItemPart,
  SelectItemText,
  Select,
  SelectSeparator as SelectSeparatorPart,
  SelectTrigger as SelectTriggerPart,
  SelectValue,
} from '@ui-sdk/react/select';
import { cn } from 'cn';
import { Check, ChevronDown } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { fieldBox } from './input.tsx';
import { listGroupLabel, listItem, listSeparator, popupSurface } from './surface.ts';

type Styled<P> = Omit<P, 'className'> & { className?: string };

function SelectTrigger({
  className,
  size = 'default',
  children,
  ...props
}: Styled<Omit<ComponentProps<typeof SelectTriggerPart>, 'children'>> & {
  size?: 'sm' | 'default';
  children?: ReactNode;
}) {
  return (
    <SelectTriggerPart
      className={cn(
        fieldBox,
        'inline-flex w-auto cursor-default items-center justify-between gap-2 text-left whitespace-nowrap data-open:border-ring data-placeholder:text-subtle [&_[data-slot=select-value]]:truncate',
        size === 'sm' ? 'h-7 pr-1.5 pl-2 text-[13px]' : 'h-8 pr-2 pl-2.5 text-sm',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronDown aria-hidden className="size-3.5 shrink-0 text-subtle" />
    </SelectTriggerPart>
  );
}

function SelectContent({
  className,
  sideOffset = 4,
  ...props
}: Styled<ComponentProps<typeof SelectContentPart>>) {
  return (
    <SelectContentPart
      sideOffset={sideOffset}
      className={cn(
        popupSurface,
        'max-h-[min(var(--available-height),24rem)] min-w-(--anchor-width) overflow-y-auto',
        className,
      )}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: Styled<Omit<ComponentProps<typeof SelectItemPart>, 'children'>> & { children?: ReactNode }) {
  return (
    <SelectItemPart className={cn(listItem, 'pr-8', className)} {...props}>
      <SelectItemText className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</SelectItemText>
      <SelectItemIndicator className="absolute right-2 flex items-center">
        <Check aria-hidden className="size-3.5 text-foreground" />
      </SelectItemIndicator>
    </SelectItemPart>
  );
}

function SelectGroupLabel({ className, ...props }: Styled<ComponentProps<typeof SelectGroupLabelPart>>) {
  return <SelectGroupLabelPart className={cn(listGroupLabel, className)} {...props} />;
}

function SelectSeparator({ className, ...props }: Styled<ComponentProps<typeof SelectSeparatorPart>>) {
  return <SelectSeparatorPart className={cn(listSeparator, className)} {...props} />;
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
