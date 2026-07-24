import type { D1Database } from '@cloudflare/workers-types';
import type { SearchProvider, SearchResult } from './provider';
import { countSearchProducts, searchProducts, suggestQuery } from '../products/search';
import { normalizeSearchQuery } from './query';

/**
 * Keyword search (SQLite FTS5) with typo-correction fallback — the default
 * backend: $0, fully local, exact-match-friendly. Encapsulates the "search → if
 * empty, suggest a correction → search again" flow the /search page used inline.
 */
export function createFtsSearch(db: D1Database): SearchProvider {
  return {
    async search(query, options = {}): Promise<SearchResult> {
      const normalized = normalizeSearchQuery(query);
      if (!normalized) return { products: [], total: 0, correctedTo: null };
      const limit = Math.max(0, Math.trunc(options.limit ?? 50));
      const offset = Math.max(0, Math.trunc(options.offset ?? 0));
      const excludeIds = options.excludeIds ?? [];
      const directTotal = await countSearchProducts(db, normalized);
      if (directTotal > 0) {
        const total =
          excludeIds.length > 0
            ? await countSearchProducts(db, normalized, excludeIds)
            : directTotal;
        const products = await searchProducts(db, normalized, limit, offset, excludeIds);
        return { products, total, correctedTo: null };
      }

      const suggestion = await suggestQuery(db, normalized);
      if (suggestion) {
        const correctedTotal = await countSearchProducts(db, suggestion);
        if (correctedTotal > 0) {
          const total =
            excludeIds.length > 0
              ? await countSearchProducts(db, suggestion, excludeIds)
              : correctedTotal;
          const products = await searchProducts(db, suggestion, limit, offset, excludeIds);
          return { products, total, correctedTo: suggestion };
        }
      }
      return { products: [], total: 0, correctedTo: null };
    },
  };
}
