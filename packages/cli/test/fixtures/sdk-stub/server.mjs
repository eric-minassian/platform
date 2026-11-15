// Test stand-in for @ericminassian/platform/server.
export async function startServer(handler) {
  globalThis.__platStubHandler = handler;
  return { close: async () => {} };
}
