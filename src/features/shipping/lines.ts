/**
 * Checkout lines → shipment weight. Every purchase path (cart, Buy now, the in-app
 * address flow, JSON) goes through this so they cannot drift apart and quote
 * different prices for the same basket.
 *
 * Weight is always read from the CURRENT D1 product/variant rows the caller already
 * resolved — never from the browser or a JSON request body, which would let a
 * shopper choose their own shipping band.
 */

import type { Product } from '../products/db';
import type { ProductVariant } from '../products/variants';
import { resolveShipmentWeight, type ResolvedShipmentWeight, type WeightLine } from './weight';

export interface CheckoutLineLike {
  product: Product;
  variant?: ProductVariant | null;
  qty: number;
  /** Display name for the "these products need a weight" message. */
  name?: string;
}

export function toWeightLine(line: CheckoutLineLike): WeightLine {
  return {
    productId: line.product.id,
    variantId: line.variant?.id ?? null,
    name: line.name ?? line.product.name,
    quantity: line.qty,
    requiresShipping: line.product.requires_shipping !== 0,
    productWeightGrams: line.product.weight_grams,
    variantWeightGrams: line.variant?.weight_grams ?? null,
  };
}

export function shipmentWeightFor(lines: CheckoutLineLike[]): ResolvedShipmentWeight {
  return resolveShipmentWeight(lines.map(toWeightLine));
}
