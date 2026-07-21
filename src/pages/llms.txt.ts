import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getConfig, formatPrice } from '../config';
import { listProducts, countProducts } from '../features/products/db';
import { listCategories } from '../features/categories/db';

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
  const origin = url.origin;
  const { storeName, currency } = getConfig();

  const total = await countProducts(env.DB);
  const products = total > 0 ? await listProducts(env.DB, total, 0) : [];
  const categories = await listCategories(env.DB);

  const productLines = products.map((p) => {
    const desc = oneLine(p.description);
    const stock = p.stock <= 0 ? ' (out of stock)' : '';
    return `- [${linkText(p.name)}](${origin}/product/${p.slug}): ${formatPrice(p.price_cents, currency)}${stock}${desc ? ` — ${desc}` : ''}`;
  });

  const categoryLines = categories.map(
    (c) => `- [${linkText(c.name)}](${origin}/category/${c.slug})`,
  );

  const body = `# ${storeName}

> ${storeName} is an online store you can browse and purchase from programmatically. All prices are in ${currency.toUpperCase()}. This file follows the llms.txt convention (https://llmstxt.org). Catalog and category links are live; an agent can complete a purchase via the JSON checkout endpoint under "For agents".

## Products
${productLines.length > 0 ? productLines.join('\n') : '- (no products listed)'}

## Categories
${categoryLines.length > 0 ? categoryLines.join('\n') : '- (no categories)'}

## For agents
- [List payment methods](${origin}/api/checkout): \`GET\` → \`{ available_methods, default }\`.
- [Create a checkout](${origin}/api/checkout): \`POST\` with \`Content-Type: application/json\`, body \`{ "items": [{ "slug": string, "quantity": number, "variant_id"?: number, "extras"?: number[] }], "method"?: string }\` → \`{ "checkout_url": string }\`. Pricing and stock are resolved server-side from \`slug\`; CORS is open for browser-based agents.
- [Search the catalog](${origin}/search?q=): append a query, e.g. \`/search?q=leather\`. Keyword + semantic matching.
- [Sitemap](${origin}/sitemap.xml): every product and category URL.
`;

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};
