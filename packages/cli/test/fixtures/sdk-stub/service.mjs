// Test stand-in for @ericminassian/platform/service.
export async function runService(program) {
  globalThis.__platStubService = program;
}
