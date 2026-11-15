import { greeting } from './shared.ts';

export default {
  queues: { jobs: async (msg: { body: unknown }) => console.log(greeting, msg.body) },
  crons: { tick: async () => console.log('tick') },
};
