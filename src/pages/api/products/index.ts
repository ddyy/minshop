import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listProducts, countProducts } from '../../../features/products/db';
import { categoriesForProducts } from '../../../features/categories/db';
import { getSearchProvider } from '../../../features/search';
import { toCatalogProduct } from '../../../features/catalog/serialize';
import { catalogJson, catalogPreflight } from '../../../features/catalog/http';
import { parseCatalogListQuery } from '../../../features/catalog/query';
import { getConfig } from '../../../config';
import { publicOrigin } from '../../../features/http/origin';
import { addCacheTags, productCacheTags } from '../../../features/cache/tags';
import { getStoreSettings } from '../../../features/settings/db';
import { hideMembersOnlyProducts } from '../../../features/auth/memberAccess';
import { memberCodeIsActive, memberSessionCodeId } from '../../../features/auth/member';

export const prerender = false;

export const OPTIONS: APIRoute = () => catalogPreflight();

/**
 * GET /api/products — machine-readable catalog for agents/tools.
 *   ?q=<query>      semantic/keyword search (uses the active search backend)
 *   ?limit=<1-100>  page size (default 24)
 *   ?offset=<n>     pagination offset
 * Returns active products only. Absolute image + product urls.
 */
export const GET: APIRoute = async ({ url, cookies }) => {
  const { query: q, limit, offset } = parseCatalogListQuery(url.searchParams);
  const origin = publicOrigin(url.origin, env.CANONICAL_ORIGIN);
  const settings = await getStoreSettings(env.DB);
  let memberAuthenticated = false;
  if (env.AUTH_SECRET) {
    const codeId = await memberSessionCodeId(
      cookies.get('member_session')?.value,
      env.AUTH_SECRET,
      Date.now() / 1000,
    );
    memberAuthenticated = !!(codeId && (await memberCodeIsActive(env.DB, codeId)));
  }
  const publicOnly = hideMembersOnlyProducts(settings, memberAuthenticated);

  let page;
  let total;
  if (q) {
    const result = await (await getSearchProvider()).search(q, { limit, offset });
    // Selective mode: drop gated hits after search (FTS/vector backends stay unchanged).
    if (publicOnly) {
      const { productRequiresMemberAccess } = await import('../../../features/auth/memberAccess');
      const visible = [];
      for (const product of result.products) {
        if (!(await productRequiresMemberAccess(env.DB, product.id))) visible.push(product);
      }
      page = visible.slice(0, limit);
      total = visible.length; // approximate after filter; fine for agents
    } else {
      total = result.total;
      page = result.products;
    }
  } else {
    page = await listProducts(env.DB, limit, offset, 'created_at DESC', { publicOnly });
    total = await countProducts(env.DB, { publicOnly });
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

  const response = catalogJson({ products, total, limit, offset, query: q || null });
  addCacheTags(response.headers, productCacheTags(page.map((product) => product.public_id)));
  return response;
};
