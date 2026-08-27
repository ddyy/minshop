/**
 * Shippo (goshippo.com) label-provider adapter.
 *
 * Plain fetch + API token (`ShippoToken`), no SDK. Payload/parse helpers are
 * pure and exported for unit tests; only the call functions touch the network.
 * Test tokens (`shippo_test_…`) purchase fake labels.
 */

import {
  defaultCarrierCodeFor,
  distanceUnitFor,
  type LabelProvider,
  type LabelQuoteInput,
  type LabelRate,
  type LabelResult,
  type OrderShipTo,
  type ParcelInput,
  type PurchasedLabel,
  type ReconcileOutcome,
  type ShipFrom,
} from './labelProvider.ts';
import type { WeightUnit } from './weight.ts';

const SHIPPO_BASE = 'https://api.goshippo.com';

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
        weight: String(parcel.weightGrams),
        mass_unit: 'g',
      },
    ],
    async: false,
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
      uncertain: res.status >= 500,
    };
  }
  return { ok: true, value: json };
}

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

interface ShippoTransactionListItem {
  object_id?: string;
  status?: string;
  rate?: string | { object_id?: string };
  metadata?: string;
  tracking_number?: string;
  tracking_url_provider?: string;
  label_url?: string;
}

export async function findShippoTransactionForRate(
  token: string,
  rateId: string,
  provider: string,
): Promise<LabelResult<ReconcileOutcome>> {
  const result = await shippo(token, `/transactions/?rate=${encodeURIComponent(rateId)}&results=25`);
  if (!result.ok) return result;
  const results = (result.value as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return { ok: false, error: 'Shippo answered with an unexpected shape; reconciliation is inconclusive.' };
  }
  const matches = (results as ShippoTransactionListItem[]).filter((tx) => {
    const txRate = typeof tx.rate === 'string' ? tx.rate : tx.rate?.object_id;
    return txRate === rateId;
  });
  if (matches.length === 0) return { ok: true, value: { state: 'pending' } };

  const toLabel = (tx: ShippoTransactionListItem): PurchasedLabel | null =>
    tx.object_id && tx.tracking_number && tx.label_url
      ? {
          transactionId: tx.object_id,
          trackingNumber: tx.tracking_number,
          trackingUrl: tx.tracking_url_provider ?? null,
          labelUrl: tx.label_url,
          provider,
        }
      : null;

  const success = matches.find((tx) => tx.status === 'SUCCESS' || tx.status === 'REFUNDREJECTED');
  if (success) {
    const label = toLabel(success);
    return label
      ? { ok: true, value: { state: 'purchased', label } }
      : { ok: false, error: 'Shippo reports a purchased label but its record is incomplete; reconcile in the dashboard.' };
  }
  if (matches.some((tx) => tx.status === 'QUEUED' || tx.status === 'WAITING' || tx.status === 'REFUNDPENDING')) {
    return { ok: true, value: { state: 'pending' } };
  }
  const refunded = matches.find((tx) => tx.status === 'REFUNDED');
  if (refunded) {
    const onlySettled = matches.every((tx) => tx.status === 'REFUNDED' || tx.status === 'ERROR');
    if (!onlySettled) {
      return { ok: false, error: 'Shippo returned conflicting transaction states; reconciliation is inconclusive.' };
    }
    const label = toLabel(refunded);
    return label
      ? { ok: true, value: { state: 'refunded', label } }
      : { ok: false, error: 'Shippo reports a refunded label but its record is incomplete; reconcile in the dashboard.' };
  }
  if (matches.every((tx) => tx.status === 'ERROR')) {
    return { ok: true, value: { state: 'none' } };
  }
  return { ok: false, error: 'Shippo reported a transaction status this version does not recognize; reconcile in the dashboard.' };
}

/** Shippo adapter implementing the label-provider port. */
export function createShippoLabelProvider(token: string): LabelProvider {
  return {
    id: 'shippo',
    fetchRates: (input: LabelQuoteInput) =>
      fetchLabelRates(
        token,
        input.from,
        input.to,
        input.parcel,
        input.weightUnit,
        input.orderPublicId,
      ),
    getRates: (shipmentId) => getShipmentRates(token, shipmentId),
    purchase: (rate, orderPublicId) =>
      purchaseLabel(token, rate.rateId, rate.provider, orderPublicId),
    findTransactionForRate: (rateId, provider) =>
      findShippoTransactionForRate(token, rateId, provider),
    carrierCodeFor: defaultCarrierCodeFor,
  };
}
