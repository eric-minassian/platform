import {
  NumberInputControl,
  NumberInputDecrement,
  NumberInputGroup,
  NumberInputIncrement,
  NumberInput as NumberInputPart,
} from '@ui-sdk/react/number-input';
import { cn } from 'cn';
import { Minus, Plus } from 'lucide-react';
import type { ComponentProps } from 'react';

const stepButton =
  'grid h-full w-7 shrink-0 cursor-default place-items-center text-subtle outline-hidden hover:bg-accent hover:text-foreground data-disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring';

/** A number with step buttons, formatted for the page's language. */
function NumberInput({
  className,
  placeholder,
  id,
  'aria-label': ariaLabel,
  ...props
}: Omit<ComponentProps<typeof NumberInputPart>, 'children'> & {
  className?: string;
  placeholder?: string;
  id?: string;
  'aria-label'?: string;
}) {
  return (
    <NumberInputPart {...props}>
      <NumberInputGroup
        className={cn(
          'flex h-8 w-full min-w-0 items-stretch overflow-hidden rounded-md border border-input bg-background transition-[border-color,box-shadow] hover:border-border-strong has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/20',
          className,
        )}
      >
        <NumberInputDecrement aria-label="Decrease" className={cn(stepButton, 'border-r')}>
          <Minus aria-hidden className="size-3.5" />
        </NumberInputDecrement>
        <NumberInputControl
          id={id}
          aria-label={ariaLabel}
          placeholder={placeholder}
          className="h-full min-w-0 flex-1 border-0 bg-transparent px-2 text-center text-sm tabular outline-hidden placeholder:text-subtle focus-visible:outline-none"
        />
        <NumberInputIncrement aria-label="Increase" className={cn(stepButton, 'border-l')}>
          <Plus aria-hidden className="size-3.5" />
        </NumberInputIncrement>
      </NumberInputGroup>
    </NumberInputPart>
  );
}

export { NumberInput };
