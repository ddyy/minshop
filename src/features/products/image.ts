import { mediaUrl } from '../media/url';
import { validateUpload } from '../media/upload';

export type ImageDelivery = 'original' | 'cloudflare';
export type ProductImageUsage = 'card' | 'detail' | 'thumbnail';

// Changing this makes every source URL new, so the whole catalog's requested
// variants count as new unique transformations for that calendar month. Bump it
// only when deliberately invalidating the transformation cache.
export const IMAGE_TRANSFORM_REVISION = '1';
export const PRODUCT_IMAGE_WIDTHS = [128, 384, 768, 1024] as const;

const USAGE_DEFAULTS: Record<
  ProductImageUsage,
  { fallbackWidth: (typeof PRODUCT_IMAGE_WIDTHS)[number]; sizes: string }
> = {
  card: {
    fallbackWidth: 384,
    sizes: '(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 384px',
  },
  detail: {
    fallbackWidth: 768,
    sizes: '(max-width: 768px) 100vw, 50vw',
  },
  thumbnail: {
    fallbackWidth: 128,
    sizes: '128px',
  },
};

export interface ProductImageSources {
  src: string;
  srcset?: string;
  sizes?: string;
}

export function onDemandImageDeliveryAvailable(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && !!url.hostname;
  } catch {
    return false;
  }
}

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
  return mediaUrl(imageKey, baseUrl);
}

/**
 * Object-key prefixes eligible for on-demand transformation.
 *
 * `media/` is where every upload has gone since the media library shipped, and
 * where the key rename moved the existing `products/` objects. Gating on
 * `products/` alone silently dropped the whole srcset ladder — the browser fell
 * back to the full-size original for every image, on every store with on-demand
 * delivery enabled. Measured on the demo: 77,830 bytes served where a 384px AVIF
 * is 10,124.
 *
 * `products/` stays for stores that have not been renamed.
 */
const TRANSFORMABLE_KEY = /^(?:products|media)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function versionedTransformSource(imageKey: string, baseUrl: string): string | null {
  // On-demand transforms require a public absolute source. Keep transformation
  // requests scoped to the store's own image prefixes on the configured origin;
  // malformed or out-of-prefix keys simply retain original delivery.
  if (!TRANSFORMABLE_KEY.test(imageKey)) return null;
  if (imageKey.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  try {
    const base = new URL(`${baseUrl.replace(/\/+$/, '')}/`);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
    const source = new URL(imageKey, base);
    if (source.origin !== base.origin || !source.pathname.startsWith(base.pathname)) return null;
    // One-time cache break for legacy objects that may previously have been
    // overwritten under a slug-based key. Future uploads always get a new key.
    source.searchParams.set('v', IMAGE_TRANSFORM_REVISION);
    return source.href;
  } catch {
    return null;
  }
}

function transformPrefix(transformOrigin = ''): string | null {
  if (!transformOrigin) return '/cdn-cgi/image/';
  try {
    const origin = new URL(transformOrigin);
    if (origin.protocol !== 'https:' && origin.protocol !== 'http:') return null;
    return `${origin.origin}/cdn-cgi/image/`;
  } catch {
    return null;
  }
}

function transformedUrl(
  source: string,
  options: string,
  transformOrigin = '',
): string | null {
  const prefix = transformPrefix(transformOrigin);
  return prefix ? `${prefix}${options}/${source}` : null;
}

/**
 * Responsive product-image attributes. Original delivery is byte-for-byte the
 * existing behavior. Cloudflare delivery uses a fixed, bounded width ladder and
 * format negotiation; the browser requests only the candidate it needs.
 */
export function productImageSources(
  imageKey: string | null,
  options: {
    baseUrl?: string;
    delivery?: ImageDelivery;
    usage?: ProductImageUsage;
    sizes?: string;
    transformOrigin?: string;
  } = {},
): ProductImageSources {
  const baseUrl = options.baseUrl ?? '';
  const original = productImageUrl(imageKey, baseUrl);
  if (!imageKey || options.delivery !== 'cloudflare' || !baseUrl) {
    return { src: original };
  }

  const source = versionedTransformSource(imageKey, baseUrl);
  if (!source) return { src: original };

  const usage = options.usage ?? 'card';
  const defaults = USAGE_DEFAULTS[usage];
  const common = 'fit=scale-down,format=auto,quality=82,onerror=redirect';
  const candidates = PRODUCT_IMAGE_WIDTHS.flatMap((width) => {
    const url = transformedUrl(
      source,
      `width=${width},${common}`,
      options.transformOrigin,
    );
    return url ? [`${url} ${width}w`] : [];
  });
  const fallback = transformedUrl(
    source,
    `width=${defaults.fallbackWidth},${common}`,
    options.transformOrigin,
  );
  if (!fallback || candidates.length === 0) return { src: original };

  return {
    src: fallback,
    srcset: candidates.join(', '),
    sizes: options.sizes ?? defaults.sizes,
  };
}

/** Fixed-size JPEG thumbnail for email clients, using the same original fallback. */
export function productEmailImageUrl(
  imageKey: string | null,
  siteOrigin: string,
  baseUrl = '',
  delivery: ImageDelivery = 'original',
): string {
  const original = new URL(productImageUrl(imageKey, baseUrl), siteOrigin).href;
  if (!imageKey || delivery !== 'cloudflare' || !baseUrl) return original;
  const source = versionedTransformSource(imageKey, baseUrl);
  if (!source) return original;
  return (
    transformedUrl(
      source,
      'width=96,height=96,fit=cover,format=jpeg,quality=80,onerror=redirect',
      siteOrigin,
    ) ?? original
  );
}

/**
 * Upload validation now lives in the shared media feature — the rules are about
 * stored files, not about products. Re-exported so existing product call sites
 * and tests keep one import.
 */
export const validateImage = validateUpload;
