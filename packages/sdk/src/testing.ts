/**
 * Test helpers for apps and the SDK itself.
 *
 *   import { useTestBindings, captureTelemetry } from '@ericminassian/platform/testing';
 *
 * For tests against real (emulated) resources use `plat test`, which starts
 * the AWS Emulator, provisions the app and sets PLATFORM_BINDINGS for vitest.
 */
import type { Bindings, TelemetryEvent } from '@ericminassian/platform-core';
import { setBindings } from './runtime/bindings.ts';
import { resetClients, type SendClient, setClient } from './runtime/clients.ts';
import { clearSecretsCache } from './runtime/secrets.ts';
import { setTelemetrySink, uninstallInstrumentation } from './runtime/telemetry.ts';

export type { SendClient } from './runtime/clients.ts';
export { createPlatformFetch } from './runtime/server.ts';
export { createWorkerHandler } from './runtime/worker.ts';

/** Complete bindings with sensible test defaults. */
export function testBindings(overrides: Partial<Bindings> = {}): Bindings {
  return {
    v: 1,
    app: 'test-app',
    stage: 'test',
    host: 'test-app.localhost',
    url: 'http://test-app.localhost:3000',
    revision: 'dtest',
    region: 'us-east-1',
    queues: {},
    secrets: {
      path: '/platform/apps/test-app/test/secrets/',
      sharedPath: '/platform/apps/test-app/_shared/secrets/',
      names: [],
    },
    stageKey: 'dGVzdC1vbmx5LXN0YWdlLWtleS1ub3QtYS1zZWNyZXQ',
    ...overrides,
  };
}

/** Install bindings for the current test process (returns them). */
export function useTestBindings(overrides: Partial<Bindings> = {}): Bindings {
  const b = testBindings(overrides);
  setBindings(b);
  return b;
}

/** Replace an AWS client with a fake `{ send(command) }`. */
export function mockClient(
  name: 'ddb' | 'sqs' | 'events' | 's3' | 'ssm' | 'lambda' | 'cognito',
  send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => unknown,
): SendClient {
  const fake: SendClient = {
    send: async (command) =>
      send(command as { constructor: { name: string }; input: Record<string, unknown> }),
  };
  setClient(name, fake);
  return fake;
}

/** Collect telemetry events instead of writing them to stdout. Call `stop()` to restore. */
export function captureTelemetry(): { events: TelemetryEvent[]; stop(): void } {
  const events: TelemetryEvent[] = [];
  setTelemetrySink((e) => events.push(e));
  return { events, stop: () => setTelemetrySink(null) };
}

/** Reset all SDK module state (bindings, clients, caches, telemetry sink). */
export function resetPlatform(): void {
  setBindings(undefined);
  resetClients();
  clearSecretsCache();
  setTelemetrySink(null);
  uninstallInstrumentation();
}
