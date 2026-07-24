import { normalizeSearchQuery } from '../search/query';

export const DEFAULT_CATALOG_LIMIT = 24;
export const MAX_CATALOG_LIMIT = 100;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export interface CatalogListQuery {
  query: string;
  limit: number;
  offset: number;
}

/** Parse the public catalog query once so routing and cache keys cannot drift. */
export function parseCatalogListQuery(params: URLSearchParams): CatalogListQuery {
  return {
    query: normalizeSearchQuery(params.get('q') ?? ''),
    limit: clampInt(params.get('limit'), DEFAULT_CATALOG_LIMIT, 1, MAX_CATALOG_LIMIT),
    offset: clampInt(params.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
  };
}
