/**
 * Object storage port (ports-and-adapters), mirroring PaymentProvider. App code
 * stores/serves by key and never imports R2 directly — swapping to S3/another
 * bucket is one new adapter.
 */

export interface StoredObject {
  body: ReadableStream;
  contentType: string;
}

export interface StorageProvider {
  put(key: string, data: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}
