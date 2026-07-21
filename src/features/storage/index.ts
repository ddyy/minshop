import { env } from 'cloudflare:workers';
import type { StorageProvider } from './provider';
import { createR2Storage } from './r2';

export type { StorageProvider } from './provider';

/** Returns the active storage provider (R2 today). Single switch point. */
export function getStorage(): StorageProvider {
  return createR2Storage(env.BUCKET);
}
