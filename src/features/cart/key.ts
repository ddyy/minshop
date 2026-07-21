/**
 * Cart-line keys + line pricing. A line is a product, optionally a chosen variant,
 * and a set of selected extras — so two of the same product with different
 * variant/extras are distinct lines. Pure (no bindings) so it's unit-testable and
 * shared by the cookie parser, the add-to-cart route, and checkout.
 *
 * Key format:  product[:variant][#extra,extra,…]
 *   "5"          product 5, no variant, no extras   (legacy/plain — still valid)
 *   "5:12"       product 5 + variant 12
 *   "5#3,7"      product 5 + extras 3 and 7 (no variant)
 *   "5:12#3,7"   product 5 + variant 12 + extras 3 and 7
 * Extras are de-duped + sorted so the same selection always yields the same key.
 */
export interface ParsedKey {
  productId: number;
  variantId: number | null;
  extraIds: number[];
}

const posInts = (xs: number[]): number[] =>
  [...new Set(xs)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);

/** Build the canonical cart key for a product + optional variant + extras. */
export function cartKey(
  productId: number,
  variantId?: number | null,
  extraIds: number[] = [],
): string {
  let key = String(productId);
  if (variantId && variantId > 0) key += `:${variantId}`;
  const ex = posInts(extraIds);
  if (ex.length) key += `#${ex.join(',')}`;
  return key;
}

/** Parse a cart key back to its parts, or null if malformed (never trust cookies). */
export function parseCartKey(key: string): ParsedKey | null {
  const [left, extrasPart] = key.split('#');
  const [pidStr, vidStr, extra] = left.split(':');
  if (extra !== undefined) return null; // more than one ':' → malformed

  const productId = Number(pidStr);
  if (!Number.isInteger(productId) || productId <= 0) return null;

  let variantId: number | null = null;
  if (vidStr !== undefined) {
    const v = Number(vidStr);
    if (!Number.isInteger(v) || v <= 0) return null;
    variantId = v;
  }

  const extraIds = extrasPart
    ? posInts(extrasPart.split(',').map(Number))
    : [];
  return { productId, variantId, extraIds };
}

/**
 * Unit price for a line: the chosen variant's price (or the product base when
 * there's no variant) plus the sum of selected extra deltas.
 */
export function lineUnitPriceCents(
  baseCents: number,
  variant: { price_cents: number } | null,
  extras: { price_delta_cents: number }[],
): number {
  const base = variant ? variant.price_cents : baseCents;
  return base + extras.reduce((sum, e) => sum + e.price_delta_cents, 0);
}
