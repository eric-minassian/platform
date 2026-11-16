// Test stand-in for @ericminassian/platform/server.
export async function startServer(handler) {
  globalThis.__platStubHandler = handler;
  return { close: async () => {} };
}

// Like the SDK's: listens where Lambda gives an endpoint, else answers the request-mode handler.
export async function serve(handler) {
  if (process.env.AWS_LAMBDA_HTTP_ENDPOINT) {
    await startServer(handler);
    return undefined;
  }
  return Object.assign(async () => {}, { requestMode: handler });
}
