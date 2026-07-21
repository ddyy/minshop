import type { D1Database } from '@cloudflare/workers-types';
import type { SearchProvider, SearchResult } from './provider';
import { searchProducts, suggestQuery } from '../products/search';

/**
 * Keyword search (SQLite FTS5) with typo-correction fallback — the default
 * backend: $0, fully local, exact-match-friendly. Encapsulates the "search → if
 * empty, suggest a correction → search again" flow the /search page used inline.
 */
export function createFtsSearch(db: D1Database): SearchProvider {
  return {
    async search(query: string): Promise<SearchResult> {
      const direct = await searchProducts(db, query);
      if (direct.length > 0) return { products: direct, correctedTo: null };

      const suggestion = await suggestQuery(db, query);
      if (suggestion) {
        const corrected = await searchProducts(db, suggestion);
        if (corrected.length > 0) return { products: corrected, correctedTo: suggestion };
      }
      return { products: [], correctedTo: null };
    },
  };
}
