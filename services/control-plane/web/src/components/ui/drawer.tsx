import {
  DrawerBackdrop,
  DrawerClose,
  DrawerContent as DrawerContentPart,
  DrawerDescription as DrawerDescriptionPart,
  Drawer as DrawerPart,
  DrawerTitle as DrawerTitlePart,
  DrawerTrigger,
} from '@ui-sdk/react/drawer';
import { cn } from 'cn';
import { X } from 'lucide-react';
import type { ComponentProps, CSSProperties } from 'react';
import { backdrop } from './dialog.tsx';

type Styled<P> = Omit<P, 'className'> & { className?: string };

/** A panel that slides in from the right edge, for editing or inspecting one thing. */
function Drawer({ side = 'right', ...props }: ComponentProps<typeof DrawerPart>) {
  return <DrawerPart side={side} {...props} />;
}

function DrawerContent({
  className,
  children,
  width = '36rem',
  closeLabel = 'Close',
  ...props
}: Styled<ComponentProps<typeof DrawerContentPart>> & { width?: string; closeLabel?: string }) {
  return (
    <>
      <DrawerBackdrop className={cn(backdrop, 'transition-none')} />
      <DrawerContentPart
        className={cn(
          'relative flex h-dvh w-[min(var(--drawer-width),100vw)] flex-col border-l bg-background text-sm text-foreground shadow-dialog outline-hidden',
          className,
        )}
        style={{ '--drawer-width': width } as CSSProperties}
        {...props}
      >
        {(state) => (
          <>
            {typeof children === 'function' ? children(state) : children}
            <DrawerClose
              aria-label={closeLabel}
              className="absolute top-3.5 right-3.5 grid size-7 place-items-center rounded-md text-subtle outline-hidden hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
            >
              <X aria-hidden className="size-4" />
            </DrawerClose>
          </>
        )}
      </DrawerContentPart>
    </>
  );
}

function DrawerHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('flex shrink-0 flex-col gap-1 border-b px-6 py-4 pr-14', className)} {...props} />
  );
}

function DrawerBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 py-5', className)} {...props} />;
}

function DrawerFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex shrink-0 items-center justify-end gap-2 border-t bg-muted px-6 py-3', className)}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: Styled<ComponentProps<typeof DrawerTitlePart>>) {
  return (
    <DrawerTitlePart
      className={cn('m-0 flex items-center gap-2 text-base font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

function DrawerDescription({ className, ...props }: Styled<ComponentProps<typeof DrawerDescriptionPart>>) {
  return (
    <DrawerDescriptionPart
      className={cn('m-0 truncate text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
};
