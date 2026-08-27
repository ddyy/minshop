/**
 * Shipping-label purchase port (fulfillment, not checkout).
 *
 * Rates and labels are bought from the admin order page after payment —
 * checkout still quotes from merchant-configured zones. Adapters (Shippo
 * today; Transglobal Express / Royal Mail later) implement this interface;
 * routes and labelStore stay provider-agnostic.
 */

import { toGrams, type WeightParseResult, type WeightUnit } from './weight.ts';

/** The store's return / collection address. */
export interface ShipFrom {
  name: string;
  street1: string;
  city: string;
  state: string;
  zip: string;
  country: string; // ISO alpha-2
}

/** Outer box dimensions. Imperial weight units imply inches; metric → cm. */
export interface ParcelInput {
  length: number;
  width: number;
  height: number;
  weightGrams: number;
}

export interface OrderShipTo {
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postal: string;
  country: string;
  email?: string | null;
}

export interface LabelRate {
  rateId: string;
  provider: string; // "USPS", "UPS", "Royal Mail", …
  service: string;
  amountCents: number;
  currency: string;
  estimatedDays: number | null;
}

export interface PurchasedLabel {
  transactionId: string;
  trackingNumber: string;
  trackingUrl: string | null;
  labelUrl: string;
  provider: string;
}

/**
 * `uncertain` marks outcomes where the request MAY have succeeded (network
 * failure, 5xx, unreadable body): for a purchase that moves money, the caller
 * must park the attempt rather than retry. Definite refusals are safe to retry.
 */
export type LabelResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; uncertain?: boolean };

/** What the provider's records say happened to an attempt we lost track of. */
export type ReconcileOutcome =
  | { state: 'purchased'; label: PurchasedLabel }
  | { state: 'refunded'; label: PurchasedLabel }
  | { state: 'pending' }
  | { state: 'none' };

export interface LabelQuoteInput {
  from: ShipFrom;
  to: OrderShipTo;
  parcel: ParcelInput;
  weightUnit: WeightUnit;
  orderPublicId?: string | null;
}

/**
 * One label backend. Opaque `shipmentId` / `rateId` values are provider-specific
 * and only meaningful when passed back to the same adapter instance.
 */
export interface LabelProvider {
  /** Stable id for settings / diagnostics (`shippo`, …). */
  readonly id: string;
  fetchRates(
    input: LabelQuoteInput,
  ): Promise<LabelResult<{ shipmentId: string; rates: LabelRate[] }>>;
  getRates(shipmentId: string): Promise<LabelResult<LabelRate[]>>;
  purchase(
    rate: LabelRate,
    orderPublicId?: string | null,
  ): Promise<LabelResult<PurchasedLabel>>;
  findTransactionForRate(
    rateId: string,
    provider: string,
  ): Promise<LabelResult<ReconcileOutcome>>;
  /** Map a provider/carrier name onto our tracking deep-link codes. */
  carrierCodeFor(provider: string): string;
}

/** Imperial weight units come with imperial rulers. */
export function distanceUnitFor(weightUnit: WeightUnit): 'in' | 'cm' {
  return weightUnit === 'lb' || weightUnit === 'oz' ? 'in' : 'cm';
}

/** Parse a parcel dimension typed by the merchant: positive, finite, ≤ 10 m. */
export function parseDimension(raw: string): number | null {
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 && n <= 1000 ? n : null;
}

export interface ParcelFormResult {
  parcel?: ParcelInput;
  error?: string;
}

/** Parse the label form's parcel fields (dimensions + weight in the store unit). */
export function parseParcelForm(
  fields: { length: string; width: string; height: string; weight: string },
  unit: WeightUnit,
): ParcelFormResult {
  const length = parseDimension(fields.length);
  const width = parseDimension(fields.width);
  const height = parseDimension(fields.height);
  if (length == null || width == null || height == null) {
    return { error: 'Enter the parcel’s length, width, and height as positive numbers.' };
  }
  const weight: WeightParseResult = toGrams(fields.weight, unit);
  if (weight.status !== 'ok' || weight.grams <= 0) {
    return { error: 'Enter the packed parcel weight as a positive number.' };
  }
  return { parcel: { length, width, height, weightGrams: weight.grams } };
}

/** Default carrier-code mapping for common aggregator names. */
export function defaultCarrierCodeFor(provider: string): string {
  const p = provider.toLowerCase();
  for (const code of ['usps', 'ups', 'fedex', 'dhl']) {
    if (p.includes(code)) return code;
  }
  return 'other';
}
