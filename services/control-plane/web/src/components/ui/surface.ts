/**
 * The looks popups share. Menu, Select and Command content keep the
 * browser's popover border, padding and background, so these set all three.
 */
export const popupSurface =
  'm-0 rounded-lg border-0 bg-popover p-1 text-sm text-foreground shadow-popover outline-hidden popup-motion';

/** One row in a menu, a select or a command list. */
export const listItem =
  "relative flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-hidden select-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground";

export const listGroupLabel = 'px-2 pt-2 pb-1 text-xs font-medium text-subtle';

export const listSeparator = '-mx-1 my-1 h-px bg-border';
