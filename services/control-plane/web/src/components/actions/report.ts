/**
 * How a page reports a finished mutation: a toast saying what happened, or
 * the server's reason it didn't. Resolves whether it succeeded, so a dialog
 * knows to close and a form to clear.
 */
import { Exit } from 'effect';
import { errorMessage } from '../../client.ts';
import { toast } from '../ui/overlays.tsx';

export async function report<A, E>(
  exit: Promise<Exit.Exit<A, E>>,
  success: string | ((value: A) => string),
): Promise<boolean> {
  const result = await exit;
  if (Exit.isFailure(result)) {
    toast.error(errorMessage(result.cause));
    return false;
  }
  toast.success(typeof success === 'string' ? success : success(result.value));
  return true;
}
