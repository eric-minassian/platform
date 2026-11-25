import {
  CommandEmpty as CommandEmptyPart,
  CommandGroup,
  CommandGroupLabel as CommandGroupLabelPart,
  CommandInput as CommandInputPart,
  CommandItem as CommandItemPart,
  CommandList as CommandListPart,
  Command as CommandPart,
  CommandSeparator as CommandSeparatorPart,
  CommandShortcut as CommandShortcutPart,
} from '@ui-sdk/react/command';
import { cn } from 'cn';
import { Search } from 'lucide-react';
import type { ComponentProps } from 'react';
import { listGroupLabel, listItem, listSeparator } from './surface.ts';

type Styled<P> = Omit<P, 'className'> & { className?: string };

function Command({ className, ...props }: Styled<ComponentProps<typeof CommandPart>>) {
  return (
    <CommandPart
      className={cn('flex min-h-0 flex-col overflow-hidden text-foreground', className)}
      {...props}
    />
  );
}

function CommandInput({ className, ...props }: Styled<ComponentProps<typeof CommandInputPart>>) {
  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b px-4">
      <Search aria-hidden className="size-4 shrink-0 text-subtle" />
      <CommandInputPart
        className={cn(
          'h-12 min-w-0 flex-1 border-0 bg-transparent p-0 text-[15px] outline-hidden placeholder:text-subtle focus-visible:outline-none',
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: Styled<ComponentProps<typeof CommandListPart>>) {
  return (
    <CommandListPart
      className={cn('max-h-[min(26rem,60dvh)] scroll-py-2 overflow-y-auto overscroll-contain p-2', className)}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: Styled<ComponentProps<typeof CommandItemPart>>) {
  return <CommandItemPart className={cn(listItem, 'min-h-9 gap-3', className)} {...props} />;
}

function CommandGroupLabel({ className, ...props }: Styled<ComponentProps<typeof CommandGroupLabelPart>>) {
  return <CommandGroupLabelPart className={cn(listGroupLabel, className)} {...props} />;
}

function CommandSeparator({ className, ...props }: Styled<ComponentProps<typeof CommandSeparatorPart>>) {
  return <CommandSeparatorPart className={cn(listSeparator, 'mx-0', className)} {...props} />;
}

function CommandEmpty({ className, ...props }: Styled<ComponentProps<typeof CommandEmptyPart>>) {
  return (
    <CommandEmptyPart
      className={cn('py-10 text-center text-sm text-muted-foreground not-data-empty:hidden', className)}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: Styled<ComponentProps<typeof CommandShortcutPart>>) {
  return <CommandShortcutPart className={cn('ml-auto text-xs text-subtle', className)} {...props} />;
}

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};
