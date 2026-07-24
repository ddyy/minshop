export const MAX_SEARCH_QUERY_LENGTH = 200;

/**
 * Keep public search work bounded and give equivalent whitespace variants one
 * cache key. Case is preserved for display; FTS normalizes it internally.
 */
export function normalizeSearchQuery(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  return Array.from(collapsed).slice(0, MAX_SEARCH_QUERY_LENGTH).join('').trim();
}
