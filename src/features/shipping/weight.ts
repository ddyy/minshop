/**
 * Shipping weight: one canonical unit (integer grams) plus the merchant-facing
 * conversion at the form boundary.
 *
 * Grams are stored because integers cannot drift, one unit keeps products and rates
 * from disagreeing, and band comparisons stay exact. `null` means UNKNOWN — never
 * "zero" and never "digital"; `products.requires_shipping` owns that.
 *
 * Pure and D1-free so both the Admin forms and the checkout resolver can use it.
 */

import type { MissingWeightRecord } from './calculator';

export type WeightUnit = 'g' | 'kg' | 'oz' | 'lb';

export const WEIGHT_UNITS: readonly WeightUnit[] = ['g', 'kg', 'oz', 'lb'];

/** One tonne. Generous for parcel shipping, tight enough to catch a unit mix-up
 *  (5000 typed into a field the merchant believes is kilograms). */
export const MAX_WEIGHT_GRAMS = 1_000_000;

const GRAMS_PER_UNIT: Record<WeightUnit, number> = {
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
};

/**
 * Display precision per unit, chosen so ONE displayed step is always finer than a
 * gram — which is what makes format→parse→format idempotent for every stored value.
 * The worst-case rounding error is half a step: lb ±0.227 g, oz ±0.142 g, kg exact
 * for integer grams, g exact. All well inside the ±0.5 g that would flip a value.
 */
const DECIMALS: Record<WeightUnit, number> = { g: 0, kg: 3, oz: 2, lb: 3 };

export function isWeightUnit(value: unknown): value is WeightUnit {
  return typeof value === 'string' && (WEIGHT_UNITS as readonly string[]).includes(value);
}

/**
 * Parsed form input. Blank is a distinct, legitimate outcome (it means "no weight
 * recorded" where weight is optional), so it must not collapse into the same `null`
 * as malformed input — the field-level error copy depends on telling them apart.
 */
export type WeightParseResult =
  | { status: 'blank' }
  | { status: 'ok'; grams: number }
  | { status: 'error'; reason: 'not_number' | 'negative' | 'precision' | 'over_limit' };

/** Plain decimal only: rejects '1e3', '0x10', 'NaN', '1,5' and other surprises. */
const DECIMAL = /^-?\d*(?:\.\d+)?$/;

/** Convert merchant input in the store's unit to integer grams, or explain why not. */
export function toGrams(value: string, unit: WeightUnit): WeightParseResult {
  const trimmed = value.trim();
  if (trimmed === '') return { status: 'blank' };
  if (!DECIMAL.test(trimmed) || trimmed === '-' || trimmed === '.') {
    return { status: 'error', reason: 'not_number' };
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { status: 'error', reason: 'not_number' };
  if (parsed < 0) return { status: 'error', reason: 'negative' };

  const decimals = trimmed.includes('.') ? trimmed.split('.')[1]!.length : 0;
  if (decimals > DECIMALS[unit]) return { status: 'error', reason: 'precision' };

  const grams = Math.round(parsed * GRAMS_PER_UNIT[unit]);
  if (!Number.isSafeInteger(grams)) return { status: 'error', reason: 'not_number' };
  if (grams > MAX_WEIGHT_GRAMS) return { status: 'error', reason: 'over_limit' };
  return { status: 'ok', grams };
}

/** Grams → a bare number string in the store unit, for a form input's value. */
export function formatWeightValue(grams: number, unit: WeightUnit): string {
  const value = grams / GRAMS_PER_UNIT[unit];
  const fixed = value.toFixed(DECIMALS[unit]);
  // Trim trailing zeroes so a round value reads '2.4', not '2.400'.
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

/** Grams → a human string with the unit, e.g. '850 g' or '2.4 kg'. */
export function formatWeight(grams: number, unit: WeightUnit): string {
  return `${formatWeightValue(grams, unit)} ${unit}`;
}

/** A variant's own weight wins; blank inherits the product's. An explicit 0 is a
 *  known weight and must not be treated as "inherit". */
export function resolveUnitWeight(
  productWeightGrams: number | null,
  variantWeightGrams: number | null,
): number | null {
  return variantWeightGrams ?? productWeightGrams;
}

export interface WeightLine {
  productId: number;
  variantId: number | null;
  name: string;
  quantity: number;
  requiresShipping: boolean;
  productWeightGrams: number | null;
  variantWeightGrams: number | null;
}

export interface ResolvedShipmentWeight {
  /** False for an all-digital cart — the caller then skips shipping entirely. */
  shippingRequired: boolean;
  /** Item weight excluding the package allowance, or null when any line is unknown. */
  itemWeightGrams: number | null;
  missingWeight: MissingWeightRecord[];
}

/**
 * Sum the shippable lines. One unknown weight makes the whole shipment unknown —
 * quietly treating it as zero is how a weight-priced store under-charges itself.
 * Lines that do not require shipping contribute nothing and are never reported as
 * missing.
 */
export function resolveShipmentWeight(lines: WeightLine[]): ResolvedShipmentWeight {
  const missingWeight: MissingWeightRecord[] = [];
  const seen = new Set<string>();
  let shippingRequired = false;
  let total = 0;
  let overflow = false;

  for (const line of lines) {
    if (!line.requiresShipping) continue;
    shippingRequired = true;

    const unit = resolveUnitWeight(line.productWeightGrams, line.variantWeightGrams);
    if (unit == null) {
      const key = `${line.productId}:${line.variantId ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        missingWeight.push({
          productId: line.productId,
          variantId: line.variantId,
          name: line.name,
        });
      }
      continue;
    }
    const lineWeight = unit * line.quantity;
    if (!Number.isSafeInteger(lineWeight)) overflow = true;
    total += lineWeight;
  }

  if (!Number.isSafeInteger(total)) overflow = true;
  const itemWeightGrams =
    !shippingRequired ? 0 : missingWeight.length > 0 || overflow ? null : total;

  return { shippingRequired, itemWeightGrams, missingWeight };
}
