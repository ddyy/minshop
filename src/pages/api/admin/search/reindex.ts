import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listAllProducts } from '../../../../features/products/db';
import { indexProducts } from '../../../../features/search';
import { getConfig } from '../../../../config';
import { getStoreSettings } from '../../../../features/settings/db';

export const prerender = false;

// POST /api/admin/search/reindex — (re)build the semantic-search index from every
// product. The runtime Admin setting overlays the build-time default.
// Run after enabling vector search, or to backfill existing products.
export const POST: APIRoute = async ({ redirect }) => {
  const back = (msg: string) => redirect(`/admin/settings?msg=${encodeURIComponent(msg)}`, 303);

  const settings = await getStoreSettings(env.DB);
  const provider = settings.searchProvider ?? getConfig().search.provider;
  if (provider !== 'vector') {
    return back('Semantic search is off — enable it in Settings first.');
  }
  if (!env.AI || !env.VECTORIZE) {
    return back('Semantic search is unavailable — add the AI and VECTORIZE bindings first.');
  }
  try {
    // listAllProducts is paginated (limit required) — pass a high cap to embed all.
    const n = await indexProducts(await listAllProducts(env.DB, 100_000));
    return back(`Reindexed ${n} product(s) into the semantic search index.`);
  } catch (err) {
    return back(`Reindex failed: ${(err as Error).message}`);
  }
};
