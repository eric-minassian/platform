import { Button as ButtonPart } from '@ui-sdk/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-default items-center justify-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-[background-color,color,border-color,box-shadow] outline-hidden select-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring data-disabled:pointer-events-none data-disabled:opacity-50 aria-disabled:opacity-50 data-pending:cursor-wait [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/85',
        outline:
          'border border-border-strong bg-background text-foreground shadow-[0_1px_1px_rgb(0_0_0/0.03)] hover:bg-accent data-open:bg-accent',
        secondary: 'bg-accent text-foreground hover:bg-active data-open:bg-active',
        ghost:
          'text-muted-foreground hover:bg-accent hover:text-foreground data-open:bg-accent data-open:text-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link: 'h-auto! px-0! text-foreground underline-offset-4 hover:underline',
      },
      size: {
        xs: "h-6 gap-1 rounded-[5px] px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 px-2.5 text-[13px] [&_svg:not([class*='size-'])]:size-3.5",
        default: 'h-8 px-3',
        lg: 'h-10 px-4',
        xl: 'h-11 px-5 text-[15px]',
        'icon-xs': "size-6 rounded-[5px] [&_svg:not([class*='size-'])]:size-3.5",
        'icon-sm': "size-7 [&_svg:not([class*='size-'])]:size-4",
        icon: 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

type ButtonProps = Omit<ComponentProps<typeof ButtonPart>, 'className'> &
  VariantProps<typeof buttonVariants> & { className?: string };

function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return <ButtonPart type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { Button, buttonVariants, type ButtonProps };
