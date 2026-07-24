import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listProducts, countProducts } from '../../../features/products/db';
import { categoriesForProducts } from '../../../features/categories/db';
import { getSearchProvider } from '../../../features/search';
import { toCatalogProduct } from '../../../features/catalog/serialize';
import { catalogJson, catalogPreflight } from '../../../features/catalog/http';
import { parseCatalogListQuery } from '../../../features/catalog/query';
import { getConfig } from '../../../config';

export const prerender = false;

export const OPTIONS: APIRoute = () => catalogPreflight();

/**
 * GET /api/products — machine-readable catalog for agents/tools.
 *   ?q=<query>      semantic/keyword search (uses the active search backend)
 *   ?limit=<1-100>  page size (default 24)
 *   ?offset=<n>     pagination offset
 * Returns active products only. Absolute image + product urls.
 */
export const GET: APIRoute = async ({ url }) => {
  const { query: q, limit, offset } = parseCatalogListQuery(url.searchParams);
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
  const categories = await categoriesForProducts(
    env.DB,
    page.map((p) => p.id),
  );
  const products = page.map((p) =>
    toCatalogProduct(
      p,
      (categories.get(p.id) ?? []).map((c) => c.name),
      origin,
      { imageBaseUrl },
    ),
  );

  return catalogJson({ products, total, limit, offset, query: q || null });
};
