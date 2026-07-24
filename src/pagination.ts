export interface PageInfo {
  page: number; // 1-based, clamped to [1, totalPages]
  pageSize: number;
  offset: number;
  total: number;
  totalPages: number;
}

/** High enough for large catalogs while bounding public cache-key cardinality. */
export const MAX_PUBLIC_PAGE = 10_000;

/** Parse a requested page once so cache keys and database offsets cannot drift. */
export function requestedPage(
  searchParams: URLSearchParams,
  maxPage = Number.MAX_SAFE_INTEGER,
): number {
  const raw = Number(searchParams.get('page'));
  return Number.isInteger(raw) && raw >= 1 ? Math.min(raw, maxPage) : 1;
}

/** Build a URL with the given query params, dropping empty/undefined ones. */
export function queryHref(
  base: string,
  params: Record<string, string | number | null | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Resolve the current page from `?page=` against a known total. */
export function paginate(
  searchParams: URLSearchParams,
  total: number,
  pageSize: number,
  maxPage = Number.MAX_SAFE_INTEGER,
): PageInfo {
  const totalPages = Math.min(maxPage, Math.max(1, Math.ceil(total / pageSize)));
  const page = Math.min(requestedPage(searchParams, maxPage), totalPages);
  return { page, pageSize, offset: (page - 1) * pageSize, total, totalPages };
}
