/**
 * A button that asks before it acts: destroying a preview, rolling back,
 * deleting a secret or an app, discarding dead letters. The dialog stays
 * open while the action runs and closes once it succeeds; on failure it
 * stays open so the viewer can retry or cancel (the action reports why).
 */
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@ui-sdk/react/alert-dialog';
import { cn } from 'cn';
import type { MouseEvent, ReactElement, ReactNode } from 'react';
import { Button, buttonVariants } from '../ui/button.tsx';
import { backdrop, dialogSurface } from '../ui/dialog.tsx';

/**
 * Popups render in place, so clicks inside one bubble through the elements
 * around it: in a clickable row they'd also click the row.
 */
const stop = (e: MouseEvent) => e.stopPropagation();

export function ConfirmAction({
  trigger,
  children,
  title,
  description,
  body,
  confirmLabel,
  destructive = true,
  canConfirm = true,
  disabled = false,
  onConfirm,
  onOpenChange,
}: {
  /** The trigger's element, e.g. `<Button variant="outline" size="sm" />`; `children` is its label. */
  trigger?: ReactElement;
  children: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Anything between the description and the buttons, such as a confirmation field. */
  body?: ReactNode;
  /** Say what it does ("Destroy pr-41"), in words the trigger doesn't use alone. */
  confirmLabel: string;
  destructive?: boolean;
  canConfirm?: boolean;
  disabled?: boolean;
  /** Resolves true when the action succeeded and the dialog can close. */
  onConfirm: () => Promise<boolean>;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <AlertDialog onOpenChange={(open) => onOpenChange?.(open)}>
      <AlertDialogTrigger
        disabled={disabled}
        render={trigger ?? <Button variant={destructive ? 'destructive' : 'outline'} size="sm" />}
        onClick={stop}
      >
        {children}
      </AlertDialogTrigger>
      <AlertDialogBackdrop className={backdrop} />
      <AlertDialogContent className={cn(dialogSurface, '[--dialog-width:28rem]')} onClick={stop}>
        <div className="flex flex-col gap-1.5 px-6 pt-5 pb-4">
          <AlertDialogTitle className="m-0 text-base font-semibold tracking-tight">{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription className="m-0 text-sm text-pretty text-muted-foreground">
              {description}
            </AlertDialogDescription>
          )}
          {body && <div className="pt-3">{body}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t bg-muted px-6 py-3">
          <AlertDialogClose className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Cancel
          </AlertDialogClose>
          <AlertDialogClose
            value="confirm"
            // An agent can open this, but agreeing takes a person.
            data-agent-confirm={confirmLabel}
            disabled={!canConfirm}
            className={buttonVariants({ variant: destructive ? 'destructive' : 'default', size: 'sm' })}
            action={async () => {
              // A rejection keeps the dialog open; the action has already said why.
              if (!(await onConfirm())) throw new Error('not done');
            }}
          >
            {confirmLabel}
          </AlertDialogClose>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
