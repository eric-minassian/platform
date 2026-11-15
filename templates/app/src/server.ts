import { Platform, toFetchHandler } from '@ericminassian/platform/effect';
import { Layer } from 'effect';
import { HttpLive } from './http.ts';

// The web server: `plat` runs this behind the platform's wrapper, which adds
// sign-in routes, request telemetry and traces.
export default toFetchHandler(HttpLive.pipe(Layer.provide(Platform.layer)));
