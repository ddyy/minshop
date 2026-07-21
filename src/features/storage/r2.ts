import type { R2Bucket } from '@cloudflare/workers-types';
import type { StorageProvider, StoredObject } from './provider';

/** Cloudflare R2 adapter for the StorageProvider port. */
export function createR2Storage(bucket: R2Bucket): StorageProvider {
  return {
    async put(key: string, data: ArrayBuffer, contentType: string): Promise<void> {
      await bucket.put(key, data, { httpMetadata: { contentType } });
    },

    async get(key: string): Promise<StoredObject | null> {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return {
        body: obj.body as unknown as ReadableStream,
        contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
      };
    },

    async delete(key: string): Promise<void> {
      await bucket.delete(key);
    },
  };
}
