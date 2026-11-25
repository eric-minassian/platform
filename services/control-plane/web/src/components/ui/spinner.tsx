import { cn } from 'cn';
import { LoaderCircle } from 'lucide-react';
import type { ComponentProps } from 'react';

/** A loading indicator that screen readers announce. */
function Spinner({ className, ...props }: ComponentProps<'svg'>) {
  return (
    <output className="inline-flex">
      <LoaderCircle
        aria-hidden
        className={cn('size-4 animate-spin text-muted-foreground', className)}
        {...props}
      />
      <span className="sr-only">Loading</span>
    </output>
  );
}

export { Spinner };
