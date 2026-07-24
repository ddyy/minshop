import type { Ai, D1Database, VectorizeIndex } from '@cloudflare/workers-types';
import type { SearchProvider, SearchResult } from './provider';
import { getProductsByIds, type Product } from '../products/db';
import { normalizeSearchQuery } from './query';

/**
 * Embed text with a Workers AI embedding model → a vector. The bge models return
 * `{ data: [[...numbers]] }`; for one input the vector is `data[0]`. Pure (takes
 * the binding as a param) so the shape-parsing is unit-testable with a mock.
 */
export async function embedText(ai: Ai, model: string, text: string): Promise<number[]> {
  // The model id is a string literal in the binding's overloads; cast through.
  const res = (await (ai as unknown as { run: (m: string, i: { text: string[] }) => Promise<unknown> }).run(
    model,
    { text: [text] },
  )) as { data?: number[][] };
  const vector = res.data?.[0];
  if (!vector || vector.length === 0) throw new Error('embedding failed: empty response');
  return vector;
}

/**
 * The text we embed for a product: name + description + its category names. The
 * category line gives the vector class context, so a query like "outdoor gear"
 * matches products in the Outdoors category even when those words aren't in the
 * name/description. `categoryNames` is optional (omitted → just name+description).
 */
export function productEmbedText(
  p: { name: string; description: string | null },
  categoryNames: string[] = [],
): string {
  const parts = [p.name];
  if (p.description) parts.push(p.description);
  if (categoryNames.length > 0) parts.push(`Categories: ${categoryNames.join(', ')}`);
  return parts.join('\n');
}

/**
 * bge-*-en-v1.5 is trained to embed QUERIES with this instruction prefix while
 * PASSAGES (the product text above) are embedded raw. Applying it on the query
 * side aligns the two and spreads similarity scores apart (relevant high,
 * off-topic low), so MIN_SCORE can meaningfully reject junk queries.
 */
const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';

/**
 * Minimum cosine similarity a match must clear to count as a result. Without this,
 * topK always returns its K nearest — so an off-topic query ("horses" against a
 * houseware catalog) still returns a full page. Tune here: raise for stricter
 * matching, lower if relevant queries come back empty.
 */
const MIN_SCORE = 0.5;

export interface VectorSearchDeps {
  db: D1Database;
  ai: Ai;
  index: VectorizeIndex;
  model: string;
  topK: number;
}

/**
 * Semantic search: embed the query, find the nearest product vectors in
 * Vectorize, then fetch those products from D1 (preserving similarity order).
 * No typo correction — meaning-based matching subsumes it.
 */
export function createVectorSearch(d: VectorSearchDeps): SearchProvider {
  return {
    async search(query, options = {}): Promise<SearchResult> {
      const trimmed = normalizeSearchQuery(query);
      if (!trimmed) return { products: [], total: 0, correctedTo: null };

      const vector = await embedText(d.ai, d.model, QUERY_INSTRUCTION + trimmed);
      const res = await d.index.query(vector, { topK: d.topK });
      const excluded = new Set(options.excludeIds ?? []);
      const ids = res.matches
        .filter((m) => (m.score ?? 0) >= MIN_SCORE) // drop "nearest but irrelevant"
        .map((m) => Number(m.id))
        .filter((n) => Number.isInteger(n) && !excluded.has(n));
      if (ids.length === 0) return { products: [], total: 0, correctedTo: null };

      const offset = Math.max(0, Math.trunc(options.offset ?? 0));
      const limit = Math.max(0, Math.trunc(options.limit ?? d.topK));
      const products = await getProductsByIds(d.db, ids);
      return {
        products: products.slice(offset, offset + limit),
        total: products.length,
        correctedTo: null,
      };
    },
  };
}

/** From Vectorize matches, the product ids excluding the source, capped at `limit`. Pure. */
export function selectRelatedIds(
  matches: { id: string }[],
  sourceId: number,
  limit: number,
): number[] {
  return matches
    .map((m) => Number(m.id))
    .filter((n) => Number.isInteger(n) && n !== sourceId)
    .slice(0, limit);
}

/**
 * Vector-powered "you may also like": products most similar (by embedding) to
 * `productId`, excluding itself. Reuses the product's STORED vector (one index
 * lookup, no re-embedding — cheap). Returns [] if the product isn't indexed, so
 * the caller can fall back to category-based related products.
 */
export async function relatedByVector(
  index: VectorizeIndex,
  db: D1Database,
  productId: number,
  limit: number,
): Promise<Product[]> {
  const got = await index.getByIds([String(productId)]);
  const vector = got[0]?.values;
  if (!vector) return [];
  const res = await index.query(vector, { topK: limit + 1 }); // +1 for the product itself
  const ids = selectRelatedIds(res.matches, productId, limit);
  if (ids.length === 0) return [];
  return getProductsByIds(db, ids);
}

/**
 * Hybrid merge for the search results: semantic (vector) matches first, then FTS
 * (exact / prefix / typo-corrected) matches not already shown. This is what makes
 * search both meaning-aware AND spelling-tolerant — a partial or misspelled query
 * like "leathe" still surfaces "leather" via FTS even when it's too far for the
 * embedding cutoff. The typo-correction hint is shown only when the semantic side
 * found nothing (so it's the FTS side that actually rescued the query). Pure.
 */
export function mergeSearchResults(vector: SearchResult, fts: SearchResult): SearchResult {
  const seen = new Set(vector.products.map((p) => p.id));
  const products = [...vector.products, ...fts.products.filter((p) => !seen.has(p.id))];
  const correctedTo = vector.products.length === 0 ? fts.correctedTo : null;
  return { products, total: products.length, correctedTo };
}
