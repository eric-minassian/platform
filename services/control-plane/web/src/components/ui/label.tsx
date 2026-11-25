import { Label as LabelPart } from '@ui-sdk/react/label';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

function Label({
  className,
  ...props
}: Omit<ComponentProps<typeof LabelPart>, 'className'> & { className?: string }) {
  return (
    <LabelPart
      className={cn(
        'inline-flex items-center gap-2 text-[13px] font-medium text-foreground select-none',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
