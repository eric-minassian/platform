import { greeting } from './shared.ts';

export default {
  fetch: (req: Request): Response => new Response(`${greeting} ${new URL(req.url).pathname}`),
};
