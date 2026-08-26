import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getProductBySlug } from '../../../features/products/db';
import { listVariants, listExtras } from '../../../features/products/variants';
import { categoriesForProduct } from '../../../features/categories/db';
import { toCatalogProduct } from '../../../features/catalog/serialize';
import { catalogJson, catalogPreflight } from '../../../features/catalog/http';
import { getConfig } from '../../../config';
import { publicOrigin } from '../../../features/http/origin';
import { addCacheTags, productCacheTags } from '../../../features/cache/tags';
import { getStoreSettings } from '../../../features/settings/db';
import { hideMembersOnlyProducts, productRequiresMemberAccess } from '../../../features/auth/memberAccess';
import { memberCodeIsActive, memberSessionCodeId } from '../../../features/auth/member';

export const prerender = false;

export const OPTIONS: APIRoute = () => catalogPreflight();

/** GET /api/products/:slug — one product as catalog JSON (with variants + extras).
    404 if missing/inactive. */
export const GET: APIRoute = async ({ params, url, cookies }) => {
  const product = params.slug ? await getProductBySlug(env.DB, params.slug) : null;
  if (!product || product.active !== 1) {
    return catalogJson({ error: 'Product not found' }, 404);
  }
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
  if (
    hideMembersOnlyProducts(settings, memberAuthenticated) &&
    (await productRequiresMemberAccess(env.DB, product.id))
  ) {
    return catalogJson({ error: 'Member access required' }, 401);
  }
  const [cats, variants, extras] = await Promise.all([
    categoriesForProduct(env.DB, product.id),
    listVariants(env.DB, product.id),
    listExtras(env.DB, product.id),
  ]);
  const response = catalogJson(
    toCatalogProduct(
      product,
      cats.map((c) => c.name),
      publicOrigin(url.origin, env.CANONICAL_ORIGIN),
      {
        variants,
        extras,
        imageBaseUrl: getConfig().images.baseUrl,
      },
    ),
  );
  addCacheTags(response.headers, productCacheTags([product.public_id]));
  return response;
};
