import type { StorageProvider } from '../storage';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

/**
 * Public URL for a product's image — the R2-served object, or the shared
 * placeholder when the product has none. Single source of truth for the
 * image/placeholder fallback, used by both the storefront and the Stripe line
 * items.
 *
 * With `baseUrl` set (config.images.baseUrl, from IMAGE_BASE_URL — e.g. an R2
 * custom domain) it returns an absolute URL that bypasses the Worker's /images
 * route; otherwise a root-relative `/images/...` path (prefix with the origin
 * for an absolute URL where one is required, e.g. Stripe/email).
 */
export function productImageUrl(imageKey: string | null, baseUrl = ''): string {
  if (!imageKey) return '/placeholder.png';
  return baseUrl ? `${baseUrl}/${imageKey}` : `/images/${imageKey}`;
}

/** Returns a user-facing error string if the upload is invalid, else null. */
export function validateImage(file: File): string | null {
  if (!ALLOWED.has(file.type)) {
    return 'Image must be JPEG, PNG, WebP, or GIF.';
  }
  if (file.size > MAX_BYTES) {
    return 'Image must be 5 MB or smaller.';
  }
  return null;
}

/** Uploads a (pre-validated) image to storage and returns its object key. */
export async function uploadProductImage(
  storage: StorageProvider,
  file: File,
): Promise<string> {
  const ext = ALLOWED.get(file.type) ?? 'bin';
  const key = `products/${crypto.randomUUID()}.${ext}`;
  await storage.put(key, await file.arrayBuffer(), file.type);
  return key;
}
