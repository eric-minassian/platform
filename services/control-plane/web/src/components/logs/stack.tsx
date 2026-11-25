/** A stack trace as the console shows it: the message and the app's own frames in full, the rest faded. */
import { cn, keyed } from '../../lib/utils.ts';

/** A stack's lines, the message and the app's own frames marked (node internals and dependencies fade). */
export function stackFrames(stack: string): Array<{ key: string; frame: string; own: boolean }> {
  return keyed(stack.split('\n'), (frame) => frame).map(({ key, item: frame }, i) => ({
    key,
    frame,
    own: i === 0 || !/node:internal|node_modules/.test(frame),
  }));
}

export function StackTrace({ stack, className }: { stack: string; className?: string }) {
  return (
    <pre
      className={cn(
        'overflow-x-auto rounded-lg border bg-muted px-3.5 py-3 font-mono text-[12px] leading-relaxed',
        className,
      )}
    >
      {stackFrames(stack).map(({ key, frame, own }) => (
        <span key={key} className={cn('block', own ? 'text-foreground' : 'text-subtle')}>
          {frame}
        </span>
      ))}
    </pre>
  );
}
