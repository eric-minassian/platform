import {
  FieldDescription as FieldDescriptionPart,
  FieldError as FieldErrorPart,
  FieldGroup as FieldGroupPart,
  FieldLabel as FieldLabelPart,
  FieldLegend as FieldLegendPart,
  Field as FieldPart,
  FieldSet as FieldSetPart,
} from '@ui-sdk/react/field';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

type Styled<P> = Omit<P, 'className'> & { className?: string };

function Field({
  className,
  orientation = 'vertical',
  ...props
}: Styled<ComponentProps<typeof FieldPart>> & { orientation?: 'vertical' | 'horizontal' }) {
  return (
    <FieldPart
      data-orientation={orientation}
      className={cn(
        'flex min-w-0 gap-1.5',
        orientation === 'vertical' ? 'flex-col' : 'flex-row items-center gap-2.5',
        className,
      )}
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }: Styled<ComponentProps<typeof FieldLabelPart>>) {
  return (
    <FieldLabelPart
      className={cn(
        'w-fit text-[13px] font-medium text-foreground select-none data-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

function FieldDescription({ className, ...props }: Styled<ComponentProps<typeof FieldDescriptionPart>>) {
  return (
    <FieldDescriptionPart
      className={cn(
        'text-[13px] text-pretty text-muted-foreground [&_code]:font-mono [&_code]:text-xs',
        className,
      )}
      {...props}
    />
  );
}

function FieldError({ className, ...props }: Styled<ComponentProps<typeof FieldErrorPart>>) {
  return <FieldErrorPart className={cn('text-[13px] text-bad', className)} {...props} />;
}

function FieldGroup({ className, ...props }: Styled<ComponentProps<typeof FieldGroupPart>>) {
  return <FieldGroupPart className={cn('flex flex-col gap-5', className)} {...props} />;
}

function FieldSet({ className, ...props }: Styled<ComponentProps<typeof FieldSetPart>>) {
  return (
    <FieldSetPart className={cn('m-0 flex min-w-0 flex-col gap-2 border-0 p-0', className)} {...props} />
  );
}

function FieldLegend({ className, ...props }: Styled<ComponentProps<typeof FieldLegendPart>>) {
  return (
    <FieldLegendPart
      className={cn('mb-1 p-0 text-[13px] font-medium text-foreground', className)}
      {...props}
    />
  );
}

export { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet };
