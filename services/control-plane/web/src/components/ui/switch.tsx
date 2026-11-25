import { Switch as SwitchPart, SwitchThumb } from '@ui-sdk/react/switch';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

function Switch({
  className,
  size = 'default',
  ...props
}: Omit<ComponentProps<typeof SwitchPart>, 'className' | 'children'> & {
  className?: string;
  size?: 'sm' | 'default';
}) {
  return (
    <SwitchPart
      className={cn(
        'group/switch inline-flex shrink-0 cursor-default items-center rounded-full border border-transparent bg-active p-0.5 transition-colors outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring data-checked:bg-foreground data-disabled:opacity-50',
        size === 'sm' ? 'h-4 w-7' : 'h-5 w-9',
        className,
      )}
      {...props}
    >
      <SwitchThumb
        className={cn(
          'pointer-events-none block rounded-full bg-background shadow-sm ring-1 ring-black/5 transition-transform duration-150 motion-reduce:transition-none',
          size === 'sm' ? 'size-3 data-checked:translate-x-3' : 'size-4 data-checked:translate-x-4',
        )}
      />
    </SwitchPart>
  );
}

export { Switch };
