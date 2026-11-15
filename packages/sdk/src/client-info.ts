import { VIEWER_ADDRESS_HEADER, VIEWER_COUNTRY_HEADER } from '@ericminassian/platform-core';
import { Effect, Result } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { IpNetwork, NetAddress } from 'effect/net';

/** Who sent the current HTTP request, as the platform's edge saw the connection. */
export interface ClientInfo {
  /** The client's address in canonical form: `203.0.113.7`, `2001:db8::7`. */
  readonly ip: string;
  /**
   * The key to rate-limit, dedupe or throttle by: the IPv4 address, or the
   * IPv6 /64 (`2001:db8:1:2::/64`). One IPv6 client rotates through
   * addresses in its /64, so its `ip` changes while `network` doesn't.
   */
  readonly network: string;
  /** ISO 3166-1 alpha-2 country, e.g. `US`. Absent under `plat dev`. */
  readonly country?: string;
}

/**
 * The client behind the current request. The edge (and `plat dev`) set it on
 * every request; one without it, like a unit test request built by hand, is
 * a defect: give it `clientHeaders(ip)` from `@ericminassian/platform/testing`.
 */
export const clientInfo: Effect.Effect<ClientInfo, never, HttpServerRequest.HttpServerRequest> =
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    const info = clientInfoFromHeaders(request.headers);
    if (info) return Effect.succeed(info);
    const value = request.headers[VIEWER_ADDRESS_HEADER];
    return Effect.die(
      new Error(
        value === undefined
          ? `The request has no client address (${VIEWER_ADDRESS_HEADER}). The platform's edge and plat dev set it; ` +
              "in unit tests, send clientHeaders('203.0.113.7') from '@ericminassian/platform/testing'."
          : `The request's client address (${VIEWER_ADDRESS_HEADER}: ${value}) is not an ip:port.`,
      ),
    );
  });

/** `ClientInfo` from the edge's headers (lowercase names), or undefined without a valid address. */
export function clientInfoFromHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): ClientInfo | undefined {
  const address = headers[VIEWER_ADDRESS_HEADER];
  const ip = address === undefined ? undefined : parseViewerAddress(address.trim());
  if (!ip) return undefined;
  const country = headers[VIEWER_COUNTRY_HEADER]?.trim();
  return {
    ip: NetAddress.formatIp(ip),
    network: NetAddress.isIpv4Address(ip)
      ? NetAddress.formatIp(ip)
      : IpNetwork.format(IpNetwork.fromAddressUnsafe(ip, 64)),
    ...(country ? { country } : {}),
  };
}

/**
 * `ip:port`. The edge doesn't bracket IPv6 (`2001:db8::7:51234`), so the port
 * is whatever follows the last colon; it is always there. An IPv4 client that
 * reached a dual-stack socket (`::ffff:203.0.113.7`) is reported as IPv4.
 */
function parseViewerAddress(value: string): NetAddress.IpAddress | undefined {
  const separator = value.lastIndexOf(':');
  if (separator < 0 || !/^\d{1,5}$/.test(value.slice(separator + 1))) return undefined;
  let host = value.slice(0, separator);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const ip = NetAddress.ipFromString(host);
  return Result.isSuccess(ip) ? NetAddress.toCanonical(ip.success) : undefined;
}
