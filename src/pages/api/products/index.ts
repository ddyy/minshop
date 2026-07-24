import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listProducts, countProducts } from '../../../features/products/db';
import { categoriesForProduct } from '../../../features/categories/db';
import { getSearchProvider } from '../../../features/search';
import { toCatalogProduct } from '../../../features/catalog/serialize';
import { catalogJson, catalogPreflight } from '../../../features/catalog/http';
import { getConfig } from '../../../config';

export const prerender = false;

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

const clampInt = (raw: string | null, def: number, min: number, max: number): number => {
  // Missing/blank param → the default. (Guard this explicitly: Number(null) and
  // Number('') are 0, which is finite, so without this the default is skipped and
  // the value clamps to `min` — e.g. limit would default to 1, not DEFAULT_LIMIT.)
  if (raw == null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
};

export const OPTIONS: APIRoute = () => catalogPreflight();

/**
 * GET /api/products — machine-readable catalog for agents/tools.
 *   ?q=<query>      semantic/keyword search (uses the active search backend)
 *   ?limit=<1-100>  page size (default 24)
 *   ?offset=<n>     pagination offset
 * Returns active products only. Absolute image + product urls.
 */
export const GET: APIRoute = async ({ url }) => {
  const q = (url.searchParams.get('q') ?? '').trim();
  const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
  const origin = url.origin;

  let page;
  let total;
  if (q) {
    const result = await (await getSearchProvider()).search(q, { limit, offset });
    total = result.total;
    page = result.products;
  } else {
    page = await listProducts(env.DB, limit, offset);
    total = await countProducts(env.DB);
  }

  const imageBaseUrl = getConfig().images.baseUrl;
  const products = await Promise.all(
    page.map(async (p) => {
      const cats = await categoriesForProduct(env.DB, p.id);
      return toCatalogProduct(p, cats.map((c) => c.name), origin, { imageBaseUrl });
    }),
  );

  return catalogJson({ products, total, limit, offset, query: q || null });
};
