// Whitelisted sort columns for the customers view. These map to SELECT aliases
// in listCustomers (email, orders, lifetime_cents, last_order).
const COLUMNS: Record<string, string> = {
  email: 'email',
  orders: 'orders',
  lifetime: 'lifetime_cents',
  last: 'last_order',
};

/** Build a safe `ORDER BY` clause for the customers view from query params. */
export function orderByClause(sort: string | null, dir: string | null): string {
  const col = (sort && COLUMNS[sort]) || 'lifetime_cents';
  const d =
    dir?.toLowerCase() === 'asc' ? 'ASC' : dir?.toLowerCase() === 'desc' ? 'DESC' : 'DESC';
  const collate = col === 'email' ? ' COLLATE NOCASE' : '';
  // Tiebreak on email (the unique grouping key — this view has no id) so ties on
  // orders/lifetime/last_order still sort deterministically AND flip asc/desc.
  const tiebreak = col === 'email' ? '' : `, email ${d}`;
  return `${col}${collate} ${d}${tiebreak}`;
}
