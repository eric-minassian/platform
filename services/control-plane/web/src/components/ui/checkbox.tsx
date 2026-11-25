import { CheckboxIndicator, Checkbox as CheckboxPart } from '@ui-sdk/react/checkbox';
import { cn } from 'cn';
import { Check, Minus } from 'lucide-react';
import type { ComponentProps } from 'react';

function Checkbox({
  className,
  ...props
}: Omit<ComponentProps<typeof CheckboxPart>, 'className' | 'children'> & { className?: string }) {
  return (
    <CheckboxPart
      className={cn(
        'inline-grid size-4 shrink-0 cursor-default place-items-center rounded-[4px] border border-border-strong bg-background text-background transition-colors outline-hidden hover:border-subtle focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring data-checked:border-foreground data-checked:bg-foreground data-disabled:opacity-50 data-indeterminate:border-foreground data-indeterminate:bg-foreground',
        className,
      )}
      {...props}
    >
      {(state) => (
        <CheckboxIndicator className="grid place-items-center">
          {state.indeterminate ? (
            <Minus aria-hidden strokeWidth={3} className="size-3" />
          ) : (
            <Check aria-hidden strokeWidth={3} className="size-3" />
          )}
        </CheckboxIndicator>
      )}
    </CheckboxPart>
  );
}

export { Checkbox };
