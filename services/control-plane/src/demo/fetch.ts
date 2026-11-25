/**
 * The demo API as an in-process fetch handler, for the console's tests: they
 * render pages in jsdom and route `fetch` here instead of starting a server.
 */
import { toFetchHandler } from '@ericminassian/platform';
import { BINDINGS_ENV, type Bindings, names } from '@ericminassian/platform-core';
import { DemoLive } from './server.ts';

process.env[BINDINGS_ENV] ??= JSON.stringify({
  v: 2,
  app: 'platform',
  stage: 'demo',
  host: 'console.test',
  url: 'http://console.test',
  revision: 'demo',
  region: 'us-east-1',
  account: '000000000000',
  secrets: {
    path: names.secretsPath('platform', 'demo'),
    sharedPath: names.sharedSecretsPath('platform'),
    names: [],
  },
} satisfies Bindings);

export const demoFetch: (request: Request) => Promise<Response> = toFetchHandler(DemoLive).fetch;
