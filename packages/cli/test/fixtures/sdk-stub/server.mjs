// Test stand-in for @eric-minassian/platform/server.
export async function startServer(handler) {
  globalThis.__platStubHandler = handler;
  return { close: async () => {} };
}
