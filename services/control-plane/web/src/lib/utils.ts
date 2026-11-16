export { cn } from 'cn';

/** Keys for items that can repeat (log lines, stack frames, result rows): the base plus its occurrence. */
export function keyed<T>(items: readonly T[], base: (item: T) => string): Array<{ key: string; item: T }> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const b = base(item);
    const n = (seen.get(b) ?? 0) + 1;
    seen.set(b, n);
    return { key: `${b}#${n}`, item };
  });
}
