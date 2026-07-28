// Admin product list filters.
//
// Same contract as sort.ts: fixed SQL fragments chosen from a whitelist, every
// value bound. The clause is shared by the list and the count query, so the
// pager can't advertise pages the filter has already excluded.

import { LOW_STOCK, type StockState } from './stock';

export interface ProductFilters {
  status: 'active' | 'inactive' | null;
  stock: StockState | null;
  /** Case-insensitive substring of the name. */
  q: string | null;
}

export const PRODUCT_STATUS_OPTIONS: { value: 'active' | 'inactive'; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Hidden' },
];

export const PRODUCT_STOCK_OPTIONS: { value: StockState; label: string }[] = [
  { value: 'in', label: 'In stock' },
  { value: 'low', label: `Low stock (≤ ${LOW_STOCK})` },
  { value: 'out', label: 'Out of stock' },
];

// The same boundaries stockState() uses for display, so a product badged "Low"
// is exactly one the Low filter returns.
const STOCK: Record<StockState, string> = {
  out: 'p.stock <= 0',
  low: `p.stock > 0 AND p.stock <= ${LOW_STOCK}`,
  in: `p.stock > ${LOW_STOCK}`,
};

/** Escape LIKE wildcards so a name containing % or _ is searched literally. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function parseProductFilters(params: URLSearchParams): ProductFilters {
  const status = params.get('status');
  const stock = params.get('stock');
  const q = (params.get('q') ?? '').trim();
  return {
    status: status === 'active' || status === 'inactive' ? status : null,
    stock: stock === 'in' || stock === 'low' || stock === 'out' ? stock : null,
    // Cap the term so a pathological query can't build a huge LIKE pattern.
    q: q ? q.slice(0, 100) : null,
  };
}

export function hasProductFilters(f: ProductFilters): boolean {
  return f.status !== null || f.stock !== null || f.q !== null;
}

export function productFilterParams(f: ProductFilters): Record<string, string | undefined> {
  return {
    status: f.status ?? undefined,
    stock: f.stock ?? undefined,
    q: f.q ?? undefined,
  };
}

export function productFilterClause(f: ProductFilters): { where: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];

  if (f.status) parts.push(f.status === 'active' ? 'p.active = 1' : 'p.active = 0');
  if (f.stock) parts.push(`(${STOCK[f.stock]})`);
  if (f.q) {
    // NOCASE matches the case-insensitive name sort, so search and sort agree.
    parts.push("p.name LIKE ? ESCAPE '\\' COLLATE NOCASE");
    params.push(`%${escapeLike(f.q)}%`);
  }

  return {
    where: parts.length ? `WHERE ${parts.join(' AND ')}` : '',
    params,
  };
}
