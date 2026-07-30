/**
 * Shipping-label purchase via Shippo (goshippo.com).
 *
 * Deliberately a FULFILLMENT feature, not a checkout one: rates are fetched and
 * the label bought from the admin order page, where latency is free and failure
 * is retryable. Checkout keeps quoting from the merchant's configured zones —
 * the carrier only enters the picture after the money has moved.
 *
 * Plain fetch + API token (`ShippoToken`), no SDK. The payload/parse helpers are
 * pure and exported for unit tests; only the two call functions touch the
 * network. Test tokens (`shippo_test_…`) purchase fake labels, which is what the
 * demo store should configure.
 */

import { toGrams, type WeightParseResult, type WeightUnit } from './weight.ts';

const SHIPPO_BASE = 'https://api.goshippo.com';

/** The store's return address — Shippo requires a full origin on every shipment. */
export interface ShipFrom {
  name: string;
  street1: string;
  city: string;
  state: string;
  zip: string;
  country: string; // ISO alpha-2
}

/** Outer box dimensions. The unit follows the store's weight unit: imperial
 *  stores (lb/oz) measure in inches, metric stores in centimetres. */
export interface ParcelInput {
  length: number;
  width: number;
  height: number;
  weightGrams: number;
}

export interface LabelRate {
  rateId: string;
  provider: string; // "USPS", "UPS", …
  service: string; // "Priority Mail", "Ground", …
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
 * must park the attempt rather than retry. Definite refusals (4xx, an ERROR
 * transaction) are safe to retry with corrections.
 */
export type LabelResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; uncertain?: boolean };

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

/** Shippo address shape from our ship-from + the order's snapshotted address. */
interface ShippoAddress {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  email?: string;
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

/** Build the create-shipment payload. Pure, so tests can pin the wire shape. */
export function buildShipmentPayload(
  from: ShipFrom,
  to: OrderShipTo,
  parcel: ParcelInput,
  weightUnit: WeightUnit,
  orderPublicId?: string | null,
): Record<string, unknown> {
  const addressFrom: ShippoAddress = {
    name: from.name,
    street1: from.street1,
    city: from.city,
    state: from.state,
    zip: from.zip,
    country: from.country.toUpperCase(),
  };
  const addressTo: ShippoAddress = {
    name: to.name,
    street1: to.line1,
    ...(to.line2 && { street2: to.line2 }),
    city: to.city,
    state: to.state ?? '',
    zip: to.postal,
    country: to.country.toUpperCase(),
    ...(to.email && { email: to.email }),
  };
  return {
    address_from: addressFrom,
    address_to: addressTo,
    parcels: [
      {
        length: String(parcel.length),
        width: String(parcel.width),
        height: String(parcel.height),
        distance_unit: distanceUnitFor(weightUnit),
        // Grams are our canonical unit and Shippo accepts them directly — no
        // conversion, no rounding drift.
        weight: String(parcel.weightGrams),
        mass_unit: 'g',
      },
    ],
    // Synchronous rating: the response carries the rates, no polling.
    async: false,
    // Cross-reference in Shippo's own records, so an uncertain purchase can be
    // resolved against the dashboard by order id.
    ...(orderPublicId && { metadata: `order ${orderPublicId}` }),
  };
}

interface ShippoRate {
  object_id?: string;
  amount?: string;
  currency?: string;
  provider?: string;
  servicelevel?: { name?: string };
  estimated_days?: number | null;
}

interface ShippoShipment {
  object_id?: string;
  status?: string;
  rates?: ShippoRate[];
  messages?: Array<{ text?: string }>;
}

/** Rates from a shipment response, cheapest first. Pure. */
export function parseRates(shipment: ShippoShipment): LabelRate[] {
  return (shipment.rates ?? [])
    .flatMap((r) => {
      const cents = Math.round(Number(r.amount) * 100);
      if (!r.object_id || !Number.isFinite(cents)) return [];
      return [
        {
          rateId: r.object_id,
          provider: r.provider ?? 'Carrier',
          service: r.servicelevel?.name ?? '',
          amountCents: cents,
          currency: (r.currency ?? 'USD').toUpperCase(),
          estimatedDays: r.estimated_days ?? null,
        },
      ];
    })
    .sort((a, b) => a.amountCents - b.amountCents);
}

/** Map Shippo's provider name onto our tracking carrier codes ('other' = no
 *  deep link, number still shown). */
export function carrierCodeFor(provider: string): string {
  const p = provider.toLowerCase();
  for (const code of ['usps', 'ups', 'fedex', 'dhl']) {
    if (p.includes(code)) return code;
  }
  return 'other';
}

async function shippo(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<LabelResult<unknown>> {
  let res: Response;
  try {
    res = await fetch(`${SHIPPO_BASE}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `ShippoToken ${token}`,
        ...(init?.body != null && { 'content-type': 'application/json' }),
      },
      ...(init?.body != null && { body: JSON.stringify(init.body) }),
    });
  } catch {
    // The request may or may not have arrived — ambiguous by definition.
    return { ok: false, error: 'Shippo is unreachable right now.', uncertain: true };
  }
  if (res.status === 401) return { ok: false, error: 'Shippo rejected the API token.' };
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return {
      ok: false,
      error: `Shippo answered ${res.status} with an unreadable body.`,
      uncertain: res.ok || res.status >= 500,
    };
  }
  if (!res.ok) {
    const detail = (json as { detail?: string }).detail;
    return {
      ok: false,
      error: detail || `Shippo answered ${res.status}.`,
      // 4xx = judged and refused; 5xx = who knows what committed first.
      uncertain: res.status >= 500,
    };
  }
  return { ok: true, value: json };
}

/** Create a shipment and return its id + rates (or the provider's complaint). */
export async function fetchLabelRates(
  token: string,
  from: ShipFrom,
  to: OrderShipTo,
  parcel: ParcelInput,
  weightUnit: WeightUnit,
  orderPublicId?: string | null,
): Promise<LabelResult<{ shipmentId: string; rates: LabelRate[] }>> {
  const result = await shippo(token, '/shipments/', {
    method: 'POST',
    body: buildShipmentPayload(from, to, parcel, weightUnit, orderPublicId),
  });
  if (!result.ok) return result;
  const shipment = result.value as ShippoShipment;
  const rates = parseRates(shipment);
  if (!shipment.object_id || rates.length === 0) {
    const why = (shipment.messages ?? []).map((m) => m.text).filter(Boolean).join(' ');
    return { ok: false, error: why || 'No carrier offered a rate for this parcel and address.' };
  }
  return { ok: true, value: { shipmentId: shipment.object_id, rates } };
}

/** Re-read a shipment's rates (the rate list page renders on a plain GET). */
export async function getShipmentRates(
  token: string,
  shipmentId: string,
): Promise<LabelResult<LabelRate[]>> {
  const result = await shippo(token, `/shipments/${encodeURIComponent(shipmentId)}`);
  if (!result.ok) return result;
  const rates = parseRates(result.value as ShippoShipment);
  if (rates.length === 0) return { ok: false, error: 'That rate list has expired. Fetch rates again.' };
  return { ok: true, value: rates };
}

interface ShippoTransaction {
  object_id?: string;
  status?: string;
  tracking_number?: string;
  tracking_url_provider?: string;
  label_url?: string;
  messages?: Array<{ text?: string }>;
}

/** Buy the label for one rate. This MOVES MONEY on the merchant's Shippo account. */
export async function purchaseLabel(
  token: string,
  rateId: string,
  provider: string,
  orderPublicId?: string | null,
): Promise<LabelResult<PurchasedLabel>> {
  const result = await shippo(token, '/transactions/', {
    method: 'POST',
    body: {
      rate: rateId,
      label_file_type: 'PDF_4x6',
      async: false,
      ...(orderPublicId && { metadata: `order ${orderPublicId}` }),
    },
  });
  if (!result.ok) return result;
  const tx = result.value as ShippoTransaction;
  if (tx.status !== 'SUCCESS' || !tx.object_id || !tx.tracking_number || !tx.label_url) {
    const why = (tx.messages ?? []).map((m) => m.text).filter(Boolean).join(' ');
    // QUEUED/other non-terminal answers are ambiguous — the charge may settle.
    const definite = tx.status === 'ERROR';
    return {
      ok: false,
      error: why || 'Shippo could not purchase that label.',
      uncertain: !definite,
    };
  }
  return {
    ok: true,
    value: {
      transactionId: tx.object_id,
      trackingNumber: tx.tracking_number,
      trackingUrl: tx.tracking_url_provider ?? null,
      labelUrl: tx.label_url,
      provider,
    },
  };
}
