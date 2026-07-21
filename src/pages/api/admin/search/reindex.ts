import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listAllProducts } from '../../../../features/products/db';
import { indexProducts } from '../../../../features/search';
import { getConfig } from '../../../../config';

export const prerender = false;

// POST /api/admin/search/reindex — (re)build the semantic-search index from every
// product (embed + upsert into Vectorize). No-op when search.provider !== 'vector'.
// Run after enabling vector search, or to backfill existing products.
export const POST: APIRoute = async ({ redirect }) => {
  const back = (msg: string) => redirect(`/admin/settings?msg=${encodeURIComponent(msg)}`, 303);

  if (getConfig().search.provider !== 'vector') {
    return back('Semantic search is off — set search.provider to "vector" first.');
  }
  try {
    // listAllProducts is paginated (limit required) — pass a high cap to embed all.
    const n = await indexProducts(await listAllProducts(env.DB, 100_000));
    return back(`Reindexed ${n} product(s) into the semantic search index.`);
  } catch (err) {
    return back(`Reindex failed: ${(err as Error).message}`);
  }
};
