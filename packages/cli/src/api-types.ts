/** Re-exports of the core API DTOs plus the few shapes core doesn't define. */
export * from '@ericminassian/platform-core';

export interface StoredObjectInfo {
  key: string;
  size: number;
  lastModified?: string;
}
