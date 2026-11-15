/**
 * Guard against creating an app whose hostname is already taken in the root
 * zone (a delegated subdomain or an explicit record beats the platform's `*`
 * wildcard, so such an app would never receive traffic).
 */
import { promises as dnsPromises } from 'node:dns';
import { Context, Data, Effect, Layer, Option } from 'effect';

export interface Resolver {
  resolveNs(host: string): Promise<string[]>;
  resolveCname(host: string): Promise<string[]>;
  resolve4(host: string): Promise<string[]>;
}

const NO_RECORD = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);

class LookupFailed extends Data.TaggedError('LookupFailed')<{ readonly code: string | undefined }> {}

export class Dns extends Context.Service<
  Dns,
  {
    /**
     * Why `host` can't be used, or none when it's free (no records, or the
     * wildcard CNAME to the platform edge). Lookups that fail for other
     * reasons than "no record" count as free, so a DNS outage never blocks
     * app creation.
     */
    hostConflict(host: string, edgeHost: string): Effect.Effect<Option.Option<string>>;
  }
>()('@ericminassian/platform-control-plane/Dns') {
  static readonly layerWith = (resolver: Resolver): Layer.Layer<Dns> =>
    Layer.succeed(
      Dns,
      Dns.of({
        hostConflict: Effect.fn('Dns.hostConflict')(
          function* (host: string, edgeHost: string) {
            const lookup = (resolve: (host: string) => Promise<string[]>) =>
              Effect.tryPromise({
                try: () => resolve(host),
                catch: (e) => new LookupFailed({ code: (e as NodeJS.ErrnoException).code }),
              }).pipe(
                Effect.catchIf(
                  (e) => NO_RECORD.has(e.code ?? ''),
                  () => Effect.succeed<string[]>([]),
                ),
              );
            const ns = yield* lookup((h) => resolver.resolveNs(h));
            if (ns.length) return Option.some(`${host} is delegated to other name servers`);
            const [cname] = yield* lookup((h) => resolver.resolveCname(h));
            if (cname !== undefined) {
              const target = cname.replace(/\.$/, '').toLowerCase();
              return target === edgeHost.toLowerCase()
                ? Option.none()
                : Option.some(`${host} already points at ${target}`);
            }
            const a = yield* lookup((h) => resolver.resolve4(h));
            if (a.length) return Option.some(`${host} already has an A record`);
            return Option.none<string>();
          },
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
      }),
    );

  static readonly layer: Layer.Layer<Dns> = Dns.layerWith(dnsPromises);
}
