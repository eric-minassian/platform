// Test stand-in for @eric-minassian/platform/worker.
export function createWorkerHandler(def) {
  return async (event) => ({ handled: Object.keys(def), event });
}
