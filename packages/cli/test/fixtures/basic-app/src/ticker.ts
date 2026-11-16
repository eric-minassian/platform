import { greeting } from './shared.ts';

// A long-running service as `defineService` compiles it (`ServiceProgram`):
// this fixture is copied without node_modules, so it can't import the SDK.
export default {
  start: async () => {},
  run: (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const tick = () => console.log(`${greeting} ticker on ${process.env.PLATFORM_SERVICE}`);
      tick();
      const timer = setInterval(tick, 200);
      if (process.env.TICKER_CRASH)
        setTimeout(() => {
          throw new Error('ticker crashed');
        }, 300);
      signal.addEventListener(
        'abort',
        () => {
          clearInterval(timer);
          console.log('ticker flushed');
          resolve();
        },
        { once: true },
      );
    }),
  dispose: async () => {},
};
