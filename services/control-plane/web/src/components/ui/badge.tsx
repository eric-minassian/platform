import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

const badgeVariants = cva(
  'inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-foreground text-background',
        secondary: 'bg-accent text-muted-foreground',
        outline: 'border border-border-strong text-muted-foreground',
        info: 'bg-info-mark/12 text-info',
        destructive: 'bg-bad-mark/12 text-bad',
      },
    },
    defaultVariants: { variant: 'secondary' },
  },
);

function Badge({
  className,
  variant,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
