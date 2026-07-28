import { isPublicCatalogApi, isPublicStorefrontPath } from './public';

export const CACHE_TAG = {
  catalog: 'catalog',
  shell: 'shell',
  product: (publicId: string) => `product:${publicId}`,
} as const;

const VALID_TAG = /^[\x21-\x2B\x2D-\x7E]{1,1024}$/;
const MAX_TAGS = 1000;

/** Validate, de-duplicate, and stabilize tags before Cloudflare sees them. */
export function normalizeCacheTags(tags: Iterable<string>): string[] {
  const normalized = [...new Set(tags)];
  if (normalized.length > MAX_TAGS) {
    throw new Error(`A response cannot carry more than ${MAX_TAGS} cache tags.`);
  }
  for (const tag of normalized) {
    // Commas are printable ASCII but delimit the Cache-Tag header, so they
    // cannot belong to one tag.
    if (!VALID_TAG.test(tag)) throw new Error(`Invalid cache tag: ${JSON.stringify(tag)}`);
  }
  return normalized.sort();
}

/** Merge tags without discarding route-specific product tags. */
export function addCacheTags(headers: Headers, tags: Iterable<string>): void {
  const existing = (headers.get('cache-tag') ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const merged = normalizeCacheTags([...existing, ...tags]);
  if (merged.length > 0) headers.set('cache-tag', merged.join(','));
}

/** Tags shared by every cacheable response in a public route family. */
export function responseCacheTags(pathname: string, status: number): string[] {
  if (status !== 200 && status !== 301) return [];
  if (isPublicCatalogApi(pathname)) return [CACHE_TAG.catalog];
  if (isPublicStorefrontPath(pathname)) {
    // Every storefront document renders the shared header/footer. Catalog data
    // also affects menu targets and the configurable home-page resolution, so
    // low-frequency catalog edits invalidate the complete storefront shell.
    return [CACHE_TAG.shell, CACHE_TAG.catalog];
  }
  return [];
}

export function productCacheTags(publicIds: Iterable<string | null | undefined>): string[] {
  return normalizeCacheTags(
    [...publicIds]
      .filter((publicId): publicId is string => /^prod_[0-9a-z]+$/.test(publicId ?? ''))
      .map(CACHE_TAG.product),
  );
}
