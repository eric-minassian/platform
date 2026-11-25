import {
  AvatarFallback as AvatarFallbackPart,
  AvatarImage as AvatarImagePart,
  Avatar as AvatarPart,
} from '@ui-sdk/react/avatar';
import { cn } from 'cn';
import type { ComponentProps } from 'react';

type Styled<P> = Omit<P, 'className'> & { className?: string };

function Avatar({ className, ...props }: Styled<ComponentProps<typeof AvatarPart>>) {
  return (
    <AvatarPart
      className={cn(
        'relative inline-flex size-6 shrink-0 overflow-hidden rounded-full bg-accent select-none',
        className,
      )}
      {...props}
    />
  );
}

function AvatarImage({ className, ...props }: Styled<ComponentProps<typeof AvatarImagePart>>) {
  return <AvatarImagePart className={cn('size-full object-cover', className)} {...props} />;
}

function AvatarFallback({ className, ...props }: Styled<ComponentProps<typeof AvatarFallbackPart>>) {
  return (
    <AvatarFallbackPart
      className={cn(
        'grid size-full place-items-center text-[10px] font-medium text-muted-foreground uppercase',
        className,
      )}
      {...props}
    />
  );
}

export { Avatar, AvatarFallback, AvatarImage };
