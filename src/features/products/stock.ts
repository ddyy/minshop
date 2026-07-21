/** Low-stock threshold for the "Only N left" cue. */
export const LOW_STOCK = 5;

export type StockState = 'out' | 'low' | 'in';

/** Classify stock for display: out (0), low (≤ LOW_STOCK), or in stock. */
export function stockState(stock: number): StockState {
  if (stock <= 0) return 'out';
  if (stock <= LOW_STOCK) return 'low';
  return 'in';
}
