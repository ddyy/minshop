import { markdownExcerpt } from '../features/pages/markdown.ts';
import type { APIRoute } from 'astro';
import { PUBLIC_CACHE_CONTROL } from '../features/cache/public';
import { env } from 'cloudflare:workers';
import { getConfig, formatPrice } from '../config';
import { listProducts, countProducts } from '../features/products/db';
import { listCategories } from '../features/categories/db';
import { listPublishedPages } from '../features/pages/db';
import { publicOrigin } from '../features/http/origin';

export const prerender = false;

// Markdown link text can't contain unescaped brackets; product names are free
// text, so strip brackets and collapse whitespace. Slugs are URL-safe already.
const linkText = (s: string) => s.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
const oneLine = (s: string | null, max = 100) => {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// /llms.txt — the llmstxt.org convention: a concise, link-rich map of the store
// for LLMs/agents. Beyond the usual catalog, it documents the JSON checkout so an
// agentic buyer can go from "what's for sale" to "place the order" without scraping.
export const GET: APIRoute = async ({ url }) => {
  const origin = publicOrigin(url.origin, env.CANONICAL_ORIGIN);
  const { storeName, currency } = getConfig();

  const total = await countProducts(env.DB);
  const products = total > 0 ? await listProducts(env.DB, total, 0) : [];
  const categories = await listCategories(env.DB);
  const pages = await listPublishedPages(env.DB);

  const productLines = products.map((p) => {
    const desc = oneLine(p.description ? markdownExcerpt(p.description, 300) : null);
    // This whole-catalog response carries coarse tags, so checkout-frequency
    // product-tag purges cannot keep stock honest here. Omit availability; the
    // catalog API and checkout resolve it through product-scoped/live reads.
    return `- [${linkText(p.name)}](${origin}/products/${p.slug}): ${formatPrice(p.price_cents, currency)}${desc ? ` — ${desc}` : ''}`;
  });

  const categoryLines = categories.map(
    (c) => `- [${linkText(c.name)}](${origin}/categories/${c.slug})`,
  );

  // Merchant-authored informational pages (shipping, returns, policies) — the
  // context an agent needs that the catalog itself doesn't carry.
  const pageLines = pages.map((p) => `- [${linkText(p.title)}](${origin}/pages/${p.slug})`);

  const body = `# ${storeName}

> ${storeName} is an online store you can browse and purchase from programmatically. All prices are in ${currency.toUpperCase()}. This file follows the llms.txt convention (https://llmstxt.org). Catalog and category links are live; an agent can complete a purchase via the JSON checkout endpoint under "For agents".

## Products
${productLines.length > 0 ? productLines.join('\n') : '- (no products listed)'}

## Categories
${categoryLines.length > 0 ? categoryLines.join('\n') : '- (no categories)'}
${pageLines.length > 0 ? `\n## Pages\n${pageLines.join('\n')}\n` : ''}
## For agents
- [List payment methods](${origin}/api/checkout): \`GET\` → \`{ available_methods, default }\`.
- [Browse the catalog as JSON](${origin}/api/products): \`GET\` (\`?q=\`, \`?limit=\`, \`?offset=\`) → products with prefixed public IDs (\`id: "prod_…"\`; the detail route \`/api/products/<slug>\` adds variants \`var_…\` and extras \`xtra_…\`).
- [Create a checkout](${origin}/api/checkout): \`POST\` with \`Content-Type: application/json\`, body \`{ "items": [{ "product_id": "prod_…", "quantity": number, "variant_id"?: "var_…", "extra_ids"?: ["xtra_…"] }], "method"?: string }\` → \`{ "checkout_url": string, "order_status_url": string }\`. IDs are the catalog's prefixed public IDs; \`slug\` is accepted in place of \`product_id\` as a convenience. Numeric IDs are rejected with 400. Pricing and stock are resolved server-side; CORS is open for browser-based callers. Poll \`order_status_url\` for \`confirming | expired | paid | refunded\`; a paid item may include a token-protected \`download_url\`. After submitting payment, keep polling through \`expired\` until \`paid\` or HTTP 410 because verified settlement can arrive late.
- [Search the catalog](${origin}/search?q=): append a query, e.g. \`/search?q=leather\`. Keyword + semantic matching.
- [Sitemap](${origin}/sitemap.xml): every product, category, and page URL.
`;

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': PUBLIC_CACHE_CONTROL,
    },
  });
};
