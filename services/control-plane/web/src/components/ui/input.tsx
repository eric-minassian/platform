import {
  Input as InputPart,
  InputClear as InputClearPart,
  InputGroup as InputGroupPart,
} from '@ui-sdk/react/input';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';

/** The field look shared by inputs, select triggers and input groups. */
export const fieldBox =
  'w-full min-w-0 rounded-md border border-input bg-background text-foreground transition-[border-color,box-shadow] outline-hidden placeholder:text-subtle hover:border-border-strong focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 focus-visible:outline-none data-disabled:opacity-50 aria-invalid:border-destructive data-invalid:border-destructive';

const inputVariants = cva(fieldBox, {
  variants: {
    size: {
      sm: 'h-7 px-2 text-[13px]',
      default: 'h-8 px-2.5 text-sm',
      lg: 'h-10 px-3 text-sm',
    },
  },
  defaultVariants: { size: 'default' },
});

type InputProps = Omit<ComponentProps<typeof InputPart>, 'className' | 'size'> &
  VariantProps<typeof inputVariants> & { className?: string };

function Input({ className, size, ...props }: InputProps) {
  return <InputPart className={cn(inputVariants({ size }), className)} {...props} />;
}

/** An input with text, icons or buttons beside it inside one box. */
function InputGroup({
  className,
  size = 'default',
  ...props
}: Omit<ComponentProps<typeof InputGroupPart>, 'className'> & {
  className?: string;
  size?: 'sm' | 'default' | 'lg';
}) {
  return (
    <InputGroupPart
      data-size={size}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-muted-foreground transition-[border-color,box-shadow] hover:border-border-strong has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/20 data-disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0',
        size === 'sm' && 'h-7 gap-1.5 px-2 text-[13px] [&>svg]:size-3.5',
        size === 'default' && 'h-8 text-sm',
        size === 'lg' && 'h-10 px-3 text-sm',
        className,
      )}
      {...props}
    />
  );
}

/** The input inside an InputGroup: the group draws the box. */
function InputGroupInput({
  className,
  ...props
}: Omit<ComponentProps<typeof InputPart>, 'className'> & { className?: string }) {
  return (
    <InputPart
      className={cn(
        'h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-foreground outline-hidden placeholder:text-subtle focus-visible:outline-none',
        className,
      )}
      {...props}
    />
  );
}

/** Text or an icon at either end of an InputGroup. */
function InputGroupAddon({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn('flex shrink-0 items-center gap-1 text-subtle [&>svg]:size-4', className)}
      {...props}
    />
  );
}

function InputClear({
  className,
  label,
  ...props
}: Omit<ComponentProps<typeof InputClearPart>, 'className' | 'children'> & {
  className?: string;
  label: string;
}) {
  return (
    <InputClearPart
      aria-label={label}
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded text-subtle hover:bg-accent hover:text-foreground',
        className,
      )}
      {...props}
    >
      <X aria-hidden className="size-3.5" />
    </InputClearPart>
  );
}

export { Input, InputClear, InputGroup, InputGroupAddon, InputGroupInput, inputVariants };
