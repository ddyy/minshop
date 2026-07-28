// Admin order list filters.
//
// Same contract as sort.ts: the query param selects a FIXED SQL fragment from a
// whitelist and every value is bound, so nothing a caller types reaches SQL.
//
// The clause built here is shared by the list query and the count query on
// purpose. Filtering one but not the other is the classic pagination bug — the
// table shows 3 rows while the pager offers 12 pages of them.

export interface OrderFilters {
  status: OrderStatusFilter | null;
  fulfillment: 'fulfilled' | 'unfulfilled' | null;
  method: string | null;
  /** Only orders still needing refund reconciliation. */
  review: boolean;
}

export type OrderStatusFilter = 'paid' | 'partially_refunded' | 'refunded' | 'pending';

/**
 * Payment states, as a merchant thinks of them.
 *
 * Refund state is DERIVED from the amounts rather than read from
 * `orders.status`, which only records 'pending' | 'paid' | 'refunded' and so
 * cannot express a partial refund at all. `refunded_cents > 0` guards the full
 * case because a zero-total order would otherwise satisfy `>= amount_total`.
 * The four are mutually exclusive and cover every row.
 */
const STATUS: Record<OrderStatusFilter, string> = {
  paid: "status = 'paid' AND refunded_cents = 0",
  partially_refunded: 'refunded_cents > 0 AND refunded_cents < amount_total_cents',
  refunded: 'refunded_cents > 0 AND refunded_cents >= amount_total_cents',
  pending: "status = 'pending'",
};

export const ORDER_STATUS_OPTIONS: { value: OrderStatusFilter; label: string }[] = [
  { value: 'paid', label: 'Paid' },
  { value: 'partially_refunded', label: 'Partially refunded' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'pending', label: 'Unpaid' },
];

export const ORDER_METHOD_OPTIONS: { value: string; label: string }[] = [
  { value: 'stripe', label: 'Card (Stripe)' },
  { value: 'lightning', label: 'Lightning' },
  { value: 'opennode', label: 'Bitcoin (OpenNode)' },
  { value: 'demo', label: 'Demo' },
];

const isStatus = (v: string | null): v is OrderStatusFilter =>
  v !== null && Object.prototype.hasOwnProperty.call(STATUS, v);

export function parseOrderFilters(params: URLSearchParams): OrderFilters {
  const status = params.get('status');
  const fulfillment = params.get('fulfillment');
  const method = params.get('method');
  return {
    status: isStatus(status) ? status : null,
    fulfillment:
      fulfillment === 'fulfilled' || fulfillment === 'unfulfilled' ? fulfillment : null,
    method: ORDER_METHOD_OPTIONS.some((o) => o.value === method) ? method : null,
    review: params.get('review') === '1',
  };
}

/** True when any filter is narrowing the list (drives the "clear" affordance). */
export function hasOrderFilters(f: OrderFilters): boolean {
  return f.status !== null || f.fulfillment !== null || f.method !== null || f.review;
}

/** The filters as query params, for building sort/pagination links that keep them. */
export function orderFilterParams(f: OrderFilters): Record<string, string | undefined> {
  return {
    status: f.status ?? undefined,
    fulfillment: f.fulfillment ?? undefined,
    method: f.method ?? undefined,
    review: f.review ? '1' : undefined,
  };
}

/**
 * `WHERE …` (or an empty string) plus its bound values. Pass the same result to
 * both the list and the count.
 */
export function orderFilterClause(f: OrderFilters): { where: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];

  if (f.status) parts.push(`(${STATUS[f.status]})`);
  if (f.fulfillment) {
    parts.push('fulfillment_status = ?');
    params.push(f.fulfillment);
  }
  if (f.method) {
    // NULL payment_method predates the column and was Stripe-only, so a Stripe
    // filter that ignored those would hide real card orders.
    parts.push(f.method === 'stripe' ? '(payment_method = ? OR payment_method IS NULL)' : 'payment_method = ?');
    params.push(f.method);
  }
  if (f.review) parts.push('refund_review_reason IS NOT NULL AND refund_reviewed_at IS NULL');

  return {
    where: parts.length ? `WHERE ${parts.join(' AND ')}` : '',
    params,
  };
}
