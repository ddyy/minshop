import { env } from 'cloudflare:workers';
import { getConfig } from '../../config';
import type { Product } from '../products/db';
import type { SearchProvider } from './provider';
import { createFtsSearch } from './fts';
import {
  createVectorSearch,
  embedText,
  productEmbedText,
  relatedByVector,
} from './vector';
import type { SearchResult } from './provider';
import { categoriesForProduct } from '../categories/db';
import { getSetting } from '../settings/db';

export type { SearchProvider, SearchResult } from './provider';

/**
 * Effective search backend. The runtime setting (Admin → Settings → Search,
 * persisted in D1) overlays the build-time default (config.search.provider /
 * SEARCH_PROVIDER) — so an owner can switch to semantic search without a redeploy.
 * Falls back to the build-time default if the setting is unset or the table is
 * missing (pre-migration).
 */
async function effectiveProvider(): Promise<'fts' | 'vector'> {
  try {
    const runtime = await getSetting(env.DB, 'search_provider');
    if (runtime === 'fts' || runtime === 'vector') return runtime;
  } catch {
    // settings table absent (pre-migration) → use the build-time default
  }
  return getConfig().search.provider;
}

/**
 * True when semantic search is selected, its bindings are present, AND we're not
 * in local dev. Vectorize has no local emulation — under `astro dev` the binding
 * object exists but every call throws "needs to be run remotely", so we treat dev
 * as not-ready and let it fall back to FTS (semantic search is a deployed concern).
 */
async function vectorReady(): Promise<boolean> {
  return (
    (await effectiveProvider()) === 'vector' &&
    !import.meta.env.DEV &&
    !!env.AI &&
    !!env.VECTORIZE
  );
}

/**
 * The active search provider. Falls back to FTS when 'vector' is selected but
 * unavailable — at selection time (bindings absent / local dev) AND at query time
 * (a Vectorize/AI failure is caught), so search degrades to keyword instead of
 * breaking the storefront.
 */
/**
 * Vector-similarity "you may also like" for a product. Returns [] when semantic
 * search isn't available (the product page falls back to category-based related).
 * Reuses the stored embedding — a cheap index lookup, no re-embedding.
 */
export async function getRelatedByVector(productId: number, limit = 4): Promise<Product[]> {
  if (!(await vectorReady())) return [];
  try {
    return await relatedByVector(env.VECTORIZE!, env.DB, productId, limit);
  } catch {
    return []; // Vectorize hiccup → fall back to category-based related
  }
}

export async function getSearchProvider(): Promise<SearchProvider> {
  const cfg = getConfig().search;
  if (!(await vectorReady())) return createFtsSearch(env.DB);

  const vector = createVectorSearch({
    db: env.DB,
    ai: env.AI!,
    index: env.VECTORIZE!,
    model: cfg.embeddingModel,
    topK: cfg.topK,
  });
  const fts = createFtsSearch(env.DB);
  return {
    // HYBRID: semantic + keyword. Run both and merge — semantic catches meaning
    // (no shared words), FTS catches exact/prefix/typo ("leathe" → "leather"). A
    // vector failure degrades to FTS-only rather than breaking search.
    async search(query, options = {}) {
      const limit = Math.max(0, Math.trunc(options.limit ?? 50));
      const offset = Math.max(0, Math.trunc(options.offset ?? 0));
      let vectorRes: SearchResult = { products: [], total: 0, correctedTo: null };
      try {
        // Semantic results are deliberately bounded by config.topK. Load that
        // complete, small set so pagination can put every semantic match before
        // keyword matches without materializing the whole FTS result set.
        vectorRes = await vector.search(query, {
          limit: cfg.topK,
          excludeIds: options.excludeIds,
        });
      } catch (err) {
        console.error('Vector search failed; FTS only:', err);
      }

      const semantic = vectorRes.products;
      const semanticIds = semantic.map((p) => p.id);
      const semanticPage = semantic.slice(offset, offset + limit);
      const remaining = Math.max(0, limit - semanticPage.length);
      const ftsOffset = Math.max(0, offset - semantic.length);
      const ftsRes = await fts.search(query, {
        limit: remaining,
        offset: ftsOffset,
        excludeIds: [...(options.excludeIds ?? []), ...semanticIds],
      });

      return {
        products: [...semanticPage, ...ftsRes.products],
        total: semantic.length + ftsRes.total,
        correctedTo: semantic.length === 0 ? ftsRes.correctedTo : null,
      };
    },
  };
}

/**
 * Upsert a product's embedding into the index. No-op unless semantic search is
 * on — so admin product writes stay binding-free in the default (FTS) config.
 * Callers should not let a failure here block the write (wrap in try/catch).
 */
export async function indexProduct(p: Product): Promise<void> {
  if (!(await vectorReady())) return;
  const cats = await categoriesForProduct(env.DB, p.id);
  const text = productEmbedText(p, cats.map((c) => c.name));
  const values = await embedText(env.AI!, getConfig().search.embeddingModel, text);
  await env.VECTORIZE!.upsert([{ id: String(p.id), values }]);
}

/** Remove a product's embedding. No-op unless semantic search is on. */
export async function unindexProduct(id: number): Promise<void> {
  if (!(await vectorReady())) return;
  await env.VECTORIZE!.deleteByIds([String(id)]);
}

/** Embed + upsert many products (the reindex/backfill path). Returns the count. */
export async function indexProducts(products: Product[]): Promise<number> {
  if (!(await vectorReady()) || products.length === 0) return 0;
  const model = getConfig().search.embeddingModel;
  const vectors = await Promise.all(
    products.map(async (p) => {
      const cats = await categoriesForProduct(env.DB, p.id);
      const values = await embedText(env.AI!, model, productEmbedText(p, cats.map((c) => c.name)));
      return { id: String(p.id), values };
    }),
  );
  await env.VECTORIZE!.upsert(vectors);
  return vectors.length;
}
