import {
  DialogBackdrop,
  DialogClose,
  DialogContent as DialogContentPart,
  DialogDescription as DialogDescriptionPart,
  Dialog,
  DialogTitle as DialogTitlePart,
  DialogTrigger,
} from '@ui-sdk/react/dialog';
import { cn } from 'cn';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';

type Styled<P> = Omit<P, 'className'> & { className?: string };

export const backdrop =
  'fixed inset-0 bg-black/40 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/60';

/** Dialogs sit in the top layer, centered: fixed to the viewport with auto margins. */
export const dialogSurface =
  'fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100dvh-4rem)] w-[min(var(--dialog-width,30rem),calc(100vw-2rem))] flex-col overflow-hidden rounded-xl bg-background p-0 text-sm text-foreground shadow-dialog outline-hidden popup-motion';

function DialogContent({
  className,
  children,
  width,
  closeLabel = 'Close',
  ...props
}: Styled<ComponentProps<typeof DialogContentPart>> & { width?: string; closeLabel?: string }) {
  return (
    <>
      <DialogBackdrop className={backdrop} />
      <DialogContentPart
        className={cn(dialogSurface, className)}
        style={width ? ({ '--dialog-width': width } as React.CSSProperties) : undefined}
        {...props}
      >
        {(state) => (
          <>
            {typeof children === 'function' ? children(state) : children}
            <DialogClose
              aria-label={closeLabel}
              className="absolute top-3.5 right-3.5 grid size-7 place-items-center rounded-md text-subtle outline-hidden hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
            >
              <X aria-hidden className="size-4" />
            </DialogClose>
          </>
        )}
      </DialogContentPart>
    </>
  );
}

function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 px-6 pt-5 pb-2 pr-12', className)} {...props} />;
}

function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 py-3', className)} {...props} />;
}

/** The action row, on a tinted band like Vercel's modals. */
function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('mt-2 flex items-center justify-end gap-2 border-t bg-muted px-6 py-3', className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: Styled<ComponentProps<typeof DialogTitlePart>>) {
  return (
    <DialogTitlePart className={cn('m-0 text-base font-semibold tracking-tight', className)} {...props} />
  );
}

function DialogDescription({ className, ...props }: Styled<ComponentProps<typeof DialogDescriptionPart>>) {
  return <DialogDescriptionPart className={cn('m-0 text-sm text-muted-foreground', className)} {...props} />;
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};
