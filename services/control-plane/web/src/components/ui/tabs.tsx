import {
  TabsIndicator,
  TabsList as TabsListPart,
  TabsPanel as TabsPanelPart,
  Tabs as TabsPart,
  TabsTab as TabsTabPart,
} from '@ui-sdk/react/tabs';
import { cn } from 'cn';
import type { ComponentProps, ReactNode } from 'react';

type Styled<P> = Omit<P, 'className'> & { className?: string };

function Tabs({ className, ...props }: Styled<ComponentProps<typeof TabsPart>>) {
  return <TabsPart className={cn('flex min-w-0 flex-col', className)} {...props} />;
}

/** Underlined tabs, with a marker that slides to the selected one. */
function TabsList({
  className,
  children,
  ...props
}: Styled<Omit<ComponentProps<typeof TabsListPart>, 'children'>> & { children?: ReactNode }) {
  return (
    <TabsListPart className={cn('relative flex items-stretch gap-1 border-b', className)} {...props}>
      {children}
      <TabsIndicator className="absolute bottom-[-1px] left-(--active-tab-left) h-0.5 w-(--active-tab-width) rounded-full bg-foreground transition-[left,width] duration-200 motion-reduce:transition-none" />
    </TabsListPart>
  );
}

function TabsTab({ className, ...props }: Styled<ComponentProps<typeof TabsTabPart>>) {
  return (
    <TabsTabPart
      className={cn(
        'relative -mb-px inline-flex h-10 cursor-default items-center gap-1.5 px-2 text-sm text-muted-foreground outline-hidden select-none hover:text-foreground focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring data-disabled:opacity-50 data-selected:text-foreground [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: Styled<ComponentProps<typeof TabsPanelPart>>) {
  return <TabsPanelPart className={cn('min-w-0 outline-hidden', className)} {...props} />;
}

export { Tabs, TabsList, TabsPanel, TabsTab };
