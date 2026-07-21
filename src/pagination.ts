export interface PageInfo {
  page: number; // 1-based, clamped to [1, totalPages]
  pageSize: number;
  offset: number;
  total: number;
  totalPages: number;
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
): PageInfo {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const raw = Number(searchParams.get('page'));
  const page = Number.isInteger(raw) && raw >= 1 ? Math.min(raw, totalPages) : 1;
  return { page, pageSize, offset: (page - 1) * pageSize, total, totalPages };
}
