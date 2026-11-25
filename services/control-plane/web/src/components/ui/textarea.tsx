import { Textarea as TextareaPart } from '@ui-sdk/react/textarea';
import { cn } from 'cn';
import type { ComponentProps } from 'react';
import { fieldBox } from './input.tsx';

function Textarea({
  className,
  ...props
}: Omit<ComponentProps<typeof TextareaPart>, 'className'> & { className?: string }) {
  return <TextareaPart className={cn(fieldBox, 'min-h-20 px-2.5 py-2 text-sm', className)} {...props} />;
}

export { Textarea };
