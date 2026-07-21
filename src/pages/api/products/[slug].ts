import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getProductBySlug } from '../../../features/products/db';
import { listVariants, listExtras } from '../../../features/products/variants';
import { categoriesForProduct } from '../../../features/categories/db';
import { toCatalogProduct } from '../../../features/catalog/serialize';
import { catalogJson, catalogPreflight } from '../../../features/catalog/http';

export const prerender = false;

export const OPTIONS: APIRoute = () => catalogPreflight();

/** GET /api/products/:slug — one product as catalog JSON (with variants + extras).
    404 if missing/inactive. */
export const GET: APIRoute = async ({ params, url }) => {
  const product = params.slug ? await getProductBySlug(env.DB, params.slug) : null;
  if (!product || product.active !== 1) {
    return catalogJson({ error: 'Product not found' }, 404);
  }
  const [cats, variants, extras] = await Promise.all([
    categoriesForProduct(env.DB, product.id),
    listVariants(env.DB, product.id),
    listExtras(env.DB, product.id),
  ]);
  return catalogJson(
    toCatalogProduct(product, cats.map((c) => c.name), url.origin, { variants, extras }),
  );
};
