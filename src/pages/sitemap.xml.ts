import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listProducts, countProducts } from '../features/products/db';
import { listCategories } from '../features/categories/db';

export const prerender = false;

// Dynamic sitemap: storefront + every active product + category. Slugs are
// URL-safe (a-z0-9-), so no XML escaping is needed.
export const GET: APIRoute = async ({ url }) => {
  const origin = url.origin;
  const total = await countProducts(env.DB);
  const products = total > 0 ? await listProducts(env.DB, total, 0) : [];
  const categories = await listCategories(env.DB);

  const locs = [
    `${origin}/`,
    ...categories.map((c) => `${origin}/category/${c.slug}`),
    ...products.map((p) => `${origin}/product/${p.slug}`),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((l) => `  <url><loc>${l}</loc></url>`).join('\n')}
</urlset>
`;

  return new Response(body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
