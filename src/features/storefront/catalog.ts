import type { D1Database } from '@cloudflare/workers-types';
import { listProducts, countProducts } from '../products/db';
import { listCategories, childrenOf } from '../categories/db';
import { orderByClause, parseStoreSortQuery, STORE_SORTS } from '../products/sort';
import { MAX_PUBLIC_PAGE, paginate, queryHref } from '../../pagination';
import { addCacheTags, productCacheTags } from '../cache/tags';
import type { ImageDelivery } from '../products/image';
import { buildProductCard } from './productCard';
import type {
  CatalogPageModel,
  StorefrontPaginationItem,
  StorefrontPaginationModel,
  StorefrontSortModel,
} from './models';

/**
 * The catalog loader.
 *
 * Everything a catalog template must not do lives here: parsing and bounding
 * query input, reading D1, tagging the response for cache invalidation, and
 * constructing URLs that keep the catalog's query semantics intact. The template
 * receives a finished model and decides only how it looks.
 */

const PAGE_SIZE = 24;

/** Matches the card slot in the default three-column grid. */
const CARD_SIZES = '(min-width: 1024px) 352px, calc(50vw - 36px)';

/**
 * Sort links deliberately drop `page`: changing the ordering while holding page
 * 7 lands the shopper in the middle of a list they have not seen.
 *
 * They always carry an explicit `sort` and `dir`, including the defaults — so
 * the default option links to `?sort=newest&dir=desc` rather than to the bare
 * path. That is pre-existing behavior, preserved here deliberately; the bare
 * path renders the same list, which is a duplicate-URL question worth revisiting
 * separately rather than changing inside an extraction.
 */
export function buildSortModel(base: string, sort: string, dir: 'asc' | 'desc'): StorefrontSortModel {
  return {
    options: STORE_SORTS.map((option) => {
      const current = sort === option.sort;
      // Re-clicking the active field flips it; an inactive field applies its own
      // natural direction (price ascending, newest descending).
      const nextDir = current ? (dir === 'asc' ? 'desc' : 'asc') : option.dir;
      return {
        label: option.label,
        href: queryHref(base, { sort: option.sort, dir: nextDir }),
        current,
        direction: current ? dir : null,
      };
    }),
  };
}

/** Compact page list with gaps, e.g. 1 … 4 5 6 … 20. */
function windowed(current: number, total: number): (number | null)[] {
  const keep = new Set<number>([1, total, current, current - 1, current + 1]);
  const pages = [...keep].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  let previous = 0;
  for (const page of pages) {
    if (page - previous > 1) out.push(null);
    out.push(page);
    previous = page;
  }
  return out;
}

export function buildPaginationModel(
  base: string,
  page: number,
  totalPages: number,
  sort: string,
  dir: 'asc' | 'desc',
): StorefrontPaginationModel {
  // Defaults are omitted from the query so page 1 of the default sort is the
  // bare path — the same URL the canonical points at.
  const hrefFor = (target: number) =>
    queryHref(base, {
      sort: sort === 'newest' ? undefined : sort,
      dir: dir === 'desc' ? undefined : dir,
      page: target > 1 ? target : undefined,
    });

  const items: StorefrontPaginationItem[] =
    totalPages > 1
      ? windowed(page, totalPages).map((target) => ({
          page: target,
          href: target === null ? null : hrefFor(target),
          current: target === page,
        }))
      : [];

  return {
    page,
    totalPages,
    prevHref: page > 1 ? hrefFor(page - 1) : null,
    nextHref: page < totalPages ? hrefFor(page + 1) : null,
    items,
  };
}

export interface CatalogPageOptions {
  /** The path currently rendering — sort and page links stay on it, so the
   *  catalog works at both `/` and `/products` without hardcoding either. */
  base: string;
  searchParams: URLSearchParams;
  /** Response headers, so product cache tags are attached where they belong. */
  responseHeaders: Headers;
  imageBaseUrl: string;
  delivery: ImageDelivery | undefined;
  eyebrow: string;
  heading: string;
}

export async function loadCatalogPage(
  db: D1Database,
  options: CatalogPageOptions,
): Promise<CatalogPageModel> {
  const { sort, dir } = parseStoreSortQuery(
    options.searchParams.get('sort'),
    options.searchParams.get('dir'),
  );
  const order = orderByClause(sort, dir);

  const [total, categories] = await Promise.all([countProducts(db), listCategories(db)]);
  const { page, offset, totalPages } = paginate(
    options.searchParams,
    total,
    PAGE_SIZE,
    MAX_PUBLIC_PAGE,
  );
  const products = await listProducts(db, PAGE_SIZE, offset, order);

  addCacheTags(
    options.responseHeaders,
    productCacheTags(products.map((product) => product.public_id)),
  );

  return {
    eyebrow: options.eyebrow,
    heading: options.heading,
    categories: childrenOf(categories, null).map((category) => ({
      text: category.name,
      href: `/categories/${category.slug}`,
    })),
    products: products.map((product, index) =>
      buildProductCard(product, {
        baseUrl: options.imageBaseUrl,
        delivery: options.delivery,
        sizes: CARD_SIZES,
        // Only the first card is the page's likely LCP image.
        priority: index === 0,
      }),
    ),
    sort: buildSortModel(options.base, sort, dir),
    pagination: buildPaginationModel(options.base, page, totalPages, sort, dir),
  };
}
