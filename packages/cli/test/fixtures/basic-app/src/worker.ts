import { greeting } from './shared.ts';

export default {
  queues: { jobs: async (msg: { body: unknown }) => console.log(greeting, msg.body) },
  crons: {
    tick: async (ctx: { remainingMs(): number }) => console.log('tick', Math.ceil(ctx.remainingMs() / 1000)),
  },
};
