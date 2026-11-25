import {
  MenuCheckboxItem as MenuCheckboxItemPart,
  MenuContent as MenuContentPart,
  MenuGroup,
  MenuGroupLabel as MenuGroupLabelPart,
  MenuItemIndicator,
  MenuItem as MenuItemPart,
  Menu,
  MenuRadioGroup,
  MenuRadioItem as MenuRadioItemPart,
  MenuSeparator as MenuSeparatorPart,
  MenuShortcut as MenuShortcutPart,
  MenuSub,
  MenuSubContent as MenuSubContentPart,
  MenuSubTrigger as MenuSubTriggerPart,
  MenuTrigger,
} from '@ui-sdk/react/menu';
import { cn } from 'cn';
import { Check, ChevronRight } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { listGroupLabel, listItem, listSeparator, popupSurface } from './surface.ts';

type Styled<P> = Omit<P, 'className'> & { className?: string };

function MenuContent({
  className,
  sideOffset = 4,
  ...props
}: Styled<ComponentProps<typeof MenuContentPart>>) {
  return (
    <MenuContentPart
      sideOffset={sideOffset}
      className={cn(popupSurface, 'max-h-(--available-height) min-w-44 overflow-y-auto', className)}
      {...props}
    />
  );
}

function MenuItem({ className, ...props }: Styled<ComponentProps<typeof MenuItemPart>>) {
  return (
    <MenuItemPart
      className={cn(listItem, 'data-destructive:text-bad data-destructive:[&_svg]:text-bad', className)}
      {...props}
    />
  );
}

function MenuCheckboxItem({
  className,
  children,
  ...props
}: Styled<Omit<ComponentProps<typeof MenuCheckboxItemPart>, 'children'>> & { children?: ReactNode }) {
  return (
    <MenuCheckboxItemPart className={cn(listItem, 'pr-8', className)} {...props}>
      {children}
      <MenuItemIndicator className="absolute right-2 flex items-center">
        <Check aria-hidden className="size-3.5 text-foreground" />
      </MenuItemIndicator>
    </MenuCheckboxItemPart>
  );
}

function MenuRadioItem({
  className,
  children,
  ...props
}: Styled<Omit<ComponentProps<typeof MenuRadioItemPart>, 'children'>> & { children?: ReactNode }) {
  return (
    <MenuRadioItemPart className={cn(listItem, 'pr-8', className)} {...props}>
      {children}
      <MenuItemIndicator className="absolute right-2 flex items-center">
        <Check aria-hidden className="size-3.5 text-foreground" />
      </MenuItemIndicator>
    </MenuRadioItemPart>
  );
}

function MenuGroupLabel({ className, ...props }: Styled<ComponentProps<typeof MenuGroupLabelPart>>) {
  return <MenuGroupLabelPart className={cn(listGroupLabel, className)} {...props} />;
}

function MenuSeparator({ className, ...props }: Styled<ComponentProps<typeof MenuSeparatorPart>>) {
  return <MenuSeparatorPart className={cn(listSeparator, className)} {...props} />;
}

function MenuShortcut({ className, ...props }: Styled<ComponentProps<typeof MenuShortcutPart>>) {
  return <MenuShortcutPart className={cn('ml-auto pl-4 text-xs text-subtle', className)} {...props} />;
}

function MenuSubTrigger({
  className,
  children,
  ...props
}: Styled<Omit<ComponentProps<typeof MenuSubTriggerPart>, 'children'>> & { children?: ReactNode }) {
  return (
    <MenuSubTriggerPart className={cn(listItem, 'data-open:bg-accent', className)} {...props}>
      {children}
      <ChevronRight aria-hidden className="ml-auto size-3.5" />
    </MenuSubTriggerPart>
  );
}

function MenuSubContent({ className, ...props }: Styled<ComponentProps<typeof MenuSubContentPart>>) {
  return <MenuSubContentPart className={cn(popupSurface, 'min-w-40', className)} {...props} />;
}

export {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
};
