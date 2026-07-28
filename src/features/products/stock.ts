/** Low-stock threshold for the customer-facing "Low stock" bucket. */
export const LOW_STOCK = 5;

export type StockState = 'out' | 'low' | 'in';
export type StockTransitionPurger = (publicIds: string[]) => Promise<void>;

/** Classify stock for display: out (0), low (≤ LOW_STOCK), or in stock. */
export function stockState(stock: number): StockState {
  if (stock <= 0) return 'out';
  if (stock <= LOW_STOCK) return 'low';
  return 'in';
}

/**
 * Products render in/low/out; individual variants render available/sold-out.
 * Exact quantities are deliberately absent, so changes within a bucket do not
 * require invalidating cached catalog responses.
 */
export function visibleStockChanged(
  hasVariant: boolean,
  before: number,
  after: number,
): boolean {
  return hasVariant
    ? (before > 0) !== (after > 0)
    : stockState(before) !== stockState(after);
}
