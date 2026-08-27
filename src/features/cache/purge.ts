import { cache } from 'cloudflare:workers';
import { normalizeCacheTags, productCacheTags } from './tags';

export interface CachePurger {
  purge(options: CachePurgeOptions): Promise<CachePurgeResult>;
}

function purgeFailure(
  mode: 'tags' | 'stock-tags' | 'everything',
  errors: CachePurgeError[] | unknown,
): void {
  console.error(
    JSON.stringify({
      event: 'workers_cache_purge_failed',
      mode,
      errors,
    }),
  );
}

/**
 * Invalidate low-frequency content mutations after their D1 write. A failed
 * tag purge falls back to the whole entrypoint cache. If both fail (Workers
 * Caching disabled, rate-limited Instant Purge, transient API errors), log and
 * return — the mutation already committed, and aborting the admin redirect
 * strands the operator on the API URL. Bounded Cache-Control TTLs cover any
 * brief staleness when caching is on.
 */
export async function purgeCacheTags(
  tags: Iterable<string>,
  purger: CachePurger = cache,
): Promise<void> {
  const normalized = normalizeCacheTags(tags);
  if (normalized.length === 0) return;

  try {
    const result = await purger.purge({ tags: normalized });
    if (result.success) return;
    purgeFailure('tags', result.errors);
  } catch (error) {
    purgeFailure('tags', error instanceof Error ? error.message : String(error));
  }

  try {
    const fallback = await purger.purge({ purgeEverything: true });
    if (fallback.success) return;
    purgeFailure('everything', fallback.errors);
  } catch (error) {
    purgeFailure('everything', error instanceof Error ? error.message : String(error));
  }
}

export function purgeProductCache(
  productPublicIds: Iterable<string | null | undefined>,
  purger?: CachePurger,
): Promise<void> {
  return purgeCacheTags(productCacheTags(productPublicIds), purger);
}

/** Purge the owning Worker entrypoint's complete cache after a deployment. */
export async function purgeEntireCache(
  purger: CachePurger = cache,
): Promise<void> {
  try {
    const result = await purger.purge({ purgeEverything: true });
    if (result.success) return;
    purgeFailure('everything', result.errors);
  } catch (error) {
    purgeFailure('everything', error instanceof Error ? error.message : String(error));
  }
  throw new Error('The Workers cache could not be purged.');
}

/**
 * Inventory transitions are checkout-frequency events. Purge only the narrow
 * product tags and never fall back to purge-everything: if Cloudflare rate
 * limits this best-effort request, the bounded shared TTL is the safety net.
 */
export async function purgeStockProductCache(
  productPublicIds: Iterable<string | null | undefined>,
  purger: CachePurger = cache,
): Promise<void> {
  const tags = productCacheTags(productPublicIds);
  if (tags.length === 0) return;

  try {
    const result = await purger.purge({ tags });
    if (result.success) return;
    purgeFailure('stock-tags', result.errors);
  } catch (error) {
    purgeFailure('stock-tags', error instanceof Error ? error.message : String(error));
  }
}
