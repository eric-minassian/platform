import { RadioGroup as RadioGroupPart, RadioIndicator, Radio as RadioPart } from '@ui-sdk/react/radio';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

type Styled<P> = Omit<P, 'className'> & { className?: string };

function RadioGroup({ className, ...props }: Styled<ComponentProps<typeof RadioGroupPart>>) {
  return <RadioGroupPart className={cn('flex flex-col gap-2', className)} {...props} />;
}

function Radio({ className, ...props }: Styled<Omit<ComponentProps<typeof RadioPart>, 'children'>>) {
  return (
    <RadioPart
      className={cn(
        'inline-grid size-4 shrink-0 cursor-default place-items-center rounded-full border border-border-strong bg-background transition-colors outline-hidden hover:border-subtle focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring data-checked:border-foreground data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <RadioIndicator className="size-2 rounded-full bg-foreground" />
    </RadioPart>
  );
}

export { Radio, RadioGroup };
