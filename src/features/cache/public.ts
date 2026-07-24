import {
  DEFAULT_CATALOG_LIMIT,
  parseCatalogListQuery,
} from '../catalog/query';
import { parseStoreSortQuery } from '../products/sort';
import { normalizeSearchQuery } from '../search/query';
import { MAX_PUBLIC_PAGE, requestedPage } from '../../pagination';

export const PUBLIC_CACHE_CONTROL = 'public, max-age=0, s-maxage=60';

export function isPublicCatalogApi(pathname: string): boolean {
  return pathname === '/api/products' || pathname.startsWith('/api/products/');
}

/** Storefront routes whose HTML is identical for every shopper. */
export function isPublicStorefrontPath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/search' ||
    pathname.startsWith('/product/') ||
    pathname.startsWith('/category/') ||
    pathname === '/robots.txt' ||
    pathname === '/sitemap.xml' ||
    pathname === '/llms.txt'
  );
}

function canonicalizeStoreList(url: URL): void {
  const { sort, dir } = parseStoreSortQuery(
    url.searchParams.get('sort'),
    url.searchParams.get('dir'),
  );
  const page = requestedPage(url.searchParams, MAX_PUBLIC_PAGE);
  url.search = '';
  if (sort !== 'newest') url.searchParams.set('sort', sort);
  if (dir !== 'desc') url.searchParams.set('dir', dir);
  if (page > 1) url.searchParams.set('page', String(page));
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
    const page = requestedPage(url.searchParams, MAX_PUBLIC_PAGE);
    url.search = '';
    if (query) url.searchParams.set('q', query);
    if (page > 1) url.searchParams.set('page', String(page));
  } else if (path === '/' || path.startsWith('/category/')) {
    canonicalizeStoreList(url);
  } else if (
    path.startsWith('/product/') ||
    path === '/robots.txt' ||
    path === '/sitemap.xml' ||
    path === '/llms.txt'
  ) {
    url.search = '';
  } else {
    url.searchParams.sort();
  }

  const headers = new Headers(request.headers);
  headers.delete('cookie');
  return new Request(url, { method: request.method, headers });
}
