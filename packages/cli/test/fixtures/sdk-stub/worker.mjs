// Test stand-in for @ericminassian/platform/worker.
export function createWorkerHandler(def) {
  return async (event) => ({ handled: Object.keys(def), event });
}
