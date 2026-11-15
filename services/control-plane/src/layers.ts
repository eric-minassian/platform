import { Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Aws } from './aws.ts';
import { Settings } from './config.ts';
import { Store } from './store.ts';

/**
 * What the API's and the worker's services build on: AWS clients, settings,
 * the state table and outbound HTTP. Each entry point adds the services it
 * calls, so the API's bundle never loads the engine.
 */
export const BaseLive = Store.layer.pipe(
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(Aws.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
