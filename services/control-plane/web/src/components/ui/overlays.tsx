/**
 * Toasts and confirmations, asked from event handlers anywhere:
 * `toast.success('Saved')`, `await confirm({ title, confirmLabel })`.
 * `<Overlays />` renders both, once, at the root.
 */
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  createConfirm,
} from '@ui-sdk/react/alert-dialog';
import { OverlayHost } from '@ui-sdk/react/overlays';
import { Toast, ToastAction, ToastClose, ToastDescription, ToastTitle, toast } from '@ui-sdk/react/toast';
import { cn } from 'cn';
import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { buttonVariants } from './button.tsx';
import { backdrop, dialogSurface } from './dialog.tsx';

export interface Question {
  readonly title: string;
  readonly description?: string;
  /** The agreeing button's text: say what it does ("Delete secret"), never "OK". */
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /** Styles the agreeing button as dangerous. */
  readonly destructive?: boolean;
}

/** Resolves true when the person agrees. */
export const confirm = createConfirm<Question>();

export { toast };

export function Overlays() {
  return (
    <>
      <OverlayHost
        toast={{
          side: 'bottom',
          align: 'end',
          className:
            'fixed right-4 bottom-4 z-50 m-0 flex w-[min(24rem,calc(100vw-2rem))] flex-col-reverse gap-2 border-0 bg-transparent p-0',
          children: () => (
            <Toast className="group/toast relative flex items-start gap-3 rounded-lg bg-popover py-3 pr-10 pl-3.5 text-sm text-foreground shadow-popover transition-[opacity,translate] duration-200 data-ending-style:translate-y-2 data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0">
              <CircleCheck
                aria-hidden
                className="mt-0.5 hidden size-4 shrink-0 text-ok group-data-[type=success]/toast:block"
              />
              <CircleAlert
                aria-hidden
                className="mt-0.5 hidden size-4 shrink-0 text-bad group-data-[type=error]/toast:block"
              />
              <TriangleAlert
                aria-hidden
                className="mt-0.5 hidden size-4 shrink-0 text-warn group-data-[type=warning]/toast:block"
              />
              <Info
                aria-hidden
                className="mt-0.5 hidden size-4 shrink-0 text-info group-data-[type=info]/toast:block"
              />
              <LoaderCircle
                aria-hidden
                className="mt-0.5 hidden size-4 shrink-0 animate-spin text-muted-foreground group-data-[type=loading]/toast:block"
              />
              <div className="min-w-0 flex-1">
                <ToastTitle className="m-0 font-medium" />
                <ToastDescription className="m-0 mt-0.5 text-[13px] text-pretty break-words text-muted-foreground empty:hidden" />
                <ToastAction
                  className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'mt-2 empty:hidden')}
                />
              </div>
              <ToastClose
                aria-label="Dismiss"
                className="absolute top-2.5 right-2.5 grid size-6 place-items-center rounded-md text-subtle outline-hidden hover:bg-accent hover:text-foreground"
              >
                <X aria-hidden className="size-3.5" />
              </ToastClose>
            </Toast>
          ),
        }}
      />
      <AlertDialog controller={confirm.controller}>
        <AlertDialogBackdrop className={backdrop} />
        <AlertDialogContent<Question> className={cn(dialogSurface, '[--dialog-width:26rem]')}>
          {({ payload }) =>
            payload && (
              <>
                <div className="flex flex-col gap-1.5 px-6 pt-5 pb-4">
                  <AlertDialogTitle className="m-0 text-base font-semibold tracking-tight">
                    {payload.title}
                  </AlertDialogTitle>
                  {payload.description && (
                    <AlertDialogDescription className="m-0 text-sm text-pretty text-muted-foreground">
                      {payload.description}
                    </AlertDialogDescription>
                  )}
                </div>
                <div className="flex justify-end gap-2 border-t bg-muted px-6 py-3">
                  <AlertDialogClose className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                    {payload.cancelLabel ?? 'Cancel'}
                  </AlertDialogClose>
                  <AlertDialogClose
                    value="confirm"
                    data-agent-confirm={payload.title}
                    className={buttonVariants({
                      variant: payload.destructive ? 'destructive' : 'default',
                      size: 'sm',
                    })}
                  >
                    {payload.confirmLabel}
                  </AlertDialogClose>
                </div>
              </>
            )
          }
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
