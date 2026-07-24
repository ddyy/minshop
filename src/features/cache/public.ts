import {
  DEFAULT_CATALOG_LIMIT,
  parseCatalogListQuery,
} from '../catalog/query';
import { normalizeSearchQuery } from '../search/query';

export const PUBLIC_CACHE_CONTROL = 'public, max-age=0, s-maxage=60';

export function isPublicCatalogApi(pathname: string): boolean {
  return pathname === '/api/products' || pathname.startsWith('/api/products/');
}

/**
 * Canonicalize cache keys for routes whose ignored/default query parameters
 * would otherwise create needless misses. The response route parses the same
 * helpers, so equivalent requests cannot disagree with their cache key.
 */
export function publicCacheRequest(request: Request): Request {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/api/products') {
    const { query, limit, offset } = parseCatalogListQuery(url.searchParams);
    url.search = '';
    if (query) url.searchParams.set('q', query);
    if (limit !== DEFAULT_CATALOG_LIMIT) url.searchParams.set('limit', String(limit));
    if (offset > 0) url.searchParams.set('offset', String(offset));
  } else if (path.startsWith('/api/products/')) {
    // Product detail ignores query parameters.
    url.search = '';
  } else if (path === '/search') {
    const query = normalizeSearchQuery(url.searchParams.get('q') ?? '');
    const rawPage = Number(url.searchParams.get('page'));
    const page = Number.isInteger(rawPage) && rawPage > 1 ? rawPage : 1;
    url.search = '';
    if (query) url.searchParams.set('q', query);
    if (page > 1) url.searchParams.set('page', String(page));
  } else {
    url.searchParams.sort();
  }

  return new Request(url, request);
}
