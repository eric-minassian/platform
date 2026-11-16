import { cn } from 'cn';
import { Loader2Icon } from 'lucide-react';

/** A loading indicator that screen readers announce. */
function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return (
    <output data-slot="spinner" className="inline-flex">
      <Loader2Icon aria-hidden className={cn('size-4 animate-spin', className)} {...props} />
      <span className="sr-only">Loading</span>
    </output>
  );
}

export { Spinner };
