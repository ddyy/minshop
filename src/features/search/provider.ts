import type { Product } from '../products/db';

/**
 * Search port. The storefront `/search` route depends on this, not on a concrete
 * backend — so FTS5 (keyword) and Vectorize (semantic) are swappable adapters
 * selected by config.search.provider. See features/search/index.ts (factory).
 */
export interface SearchResult {
  products: Product[];
  /** Total matches in this provider's bounded result set, before pagination. */
  total: number;
  /**
   * When a search auto-corrected the query (the FTS typo path), the query
   * actually used — for a "showing results for X" banner. null otherwise
   * (including semantic search, which matches by meaning and doesn't correct).
   */
  correctedTo: string | null;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  /** Product ids already supplied by a higher-priority provider. */
  excludeIds?: number[];
}

export interface SearchProvider {
  /** Search active products for `query`. */
  search(query: string, options?: SearchOptions): Promise<SearchResult>;
}
