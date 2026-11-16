/**
 * A button that asks before it acts: destroying a preview, rolling back,
 * deleting a secret or an app, discarding dead letters. The dialog stays
 * open while the action runs and closes once it succeeds; on failure it
 * stays open so the viewer can retry or cancel (the action reports why).
 */
import { type MouseEvent, type ReactElement, type ReactNode, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../ui/alert-dialog.tsx';
import { Button } from '../ui/button.tsx';

/**
 * Clicks in the dialog's portal still bubble through React's tree, so in a
 * clickable table row its trigger and its buttons would also click the row.
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
  confirmLabel: string;
  destructive?: boolean;
  canConfirm?: boolean;
  disabled?: boolean;
  /** Resolves true when the action succeeded and the dialog can close. */
  onConfirm: () => Promise<boolean>;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const change = (next: boolean) => {
    if (busy) return;
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogTrigger
        disabled={disabled}
        render={trigger ?? <Button variant={destructive ? 'destructive' : 'outline'} size="sm" />}
        onClick={stop}
      >
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md" onClick={stop}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {body}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy || !canConfirm}
            onClick={() =>
              void (async () => {
                setBusy(true);
                const done = await onConfirm();
                setBusy(false);
                if (done) {
                  setOpen(false);
                  onOpenChange?.(false);
                }
              })()
            }
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
