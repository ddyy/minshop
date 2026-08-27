/**
 * Royal Mail Click & Drop — push paid orders into C&D for dashboard labelling,
 * then poll for print/despatch so we can fulfill in minshop.
 *
 * There is **no webhook** for custom API integrations (Shopify/eBay native
 * channels are updated by Royal Mail on their side). We poll
 * `GET /orders/{orderIdentifier}` from Admin sync and the Worker cron.
 *
 * Non-OBA accounts cannot fetch postage-label PDFs via the API
 * (`GET /orders/{id}/label` is OBA-only). Tracking + fulfill is the sync path.
 *
 * API: https://api.parcel.royalmail.com/ (Bearer integration key)
 * Docs: https://api.parcel.royalmail.com/doc/v1/click-and-drop-api-v1.yaml
 */

import { toMajorUnits } from '../../money.ts';
import type { Order, OrderItem, ShippingAddress } from '../orders/db.ts';

const API_BASE = 'https://api.parcel.royalmail.com/api/v1';
/** C&D merchant UI — order detail path uses the numeric orderIdentifier. */
const DASHBOARD_ORDER = 'https://business.parcel.royalmail.com/orders';

export type ClickDropResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; uncertain?: boolean };

export interface ClickDropPushResult {
  orderIdentifier: number;
  orderReference: string | null;
  /** Best-effort deep link into the Click & Drop UI for this order. */
  dashboardUrl: string;
  trackingNumber: string | null;
}

export function clickDropDashboardUrl(orderIdentifier: number): string {
  return `${DASHBOARD_ORDER}/${orderIdentifier}`;
}

/** Orders list with a reference hint when the SPA path is unavailable. */
export function clickDropOrdersListUrl(): string {
  return `${DASHBOARD_ORDER}/`;
}

export function packageFormatForWeightGrams(grams: number): string {
  if (grams <= 100) return 'largeLetter';
  if (grams <= 2000) return 'smallParcel';
  if (grams <= 10000) return 'mediumParcel';
  return 'largeParcel';
}

export interface ClickDropPushInput {
  order: Pick<
    Order,
    | 'public_id'
    | 'email'
    | 'amount_total_cents'
    | 'shipping_cents'
    | 'discount_cents'
    | 'tax_cents'
    | 'currency'
    | 'shipping_weight_grams'
    | 'created_at'
  >;
  shipTo: ShippingAddress;
  items: Array<Pick<OrderItem, 'name' | 'price_cents' | 'quantity'>>;
}

/** Pure: CreateOrdersRequest body (no credentials). */
export function buildClickDropCreatePayload(input: ClickDropPushInput): Record<string, unknown> {
  const { order, shipTo, items } = input;
  const currency = (order.currency || 'GBP').toUpperCase();
  const subtotalCents = Math.max(
    0,
    order.amount_total_cents - order.shipping_cents - order.tax_cents + order.discount_cents,
  );
  // Line-item sum is preferred for subtotal when present.
  const linesCents = items.reduce((s, it) => s + it.price_cents * it.quantity, 0);
  const goodsCents = linesCents > 0 ? linesCents : subtotalCents;

  const weightGrams = Math.max(1, Math.min(30000, order.shipping_weight_grams ?? 500));
  const ref = (order.public_id ?? `order-${order.created_at}`).slice(0, 40);

  const contents =
    items.length > 0
      ? items.map((it) => ({
          name: it.name.slice(0, 800),
          quantity: it.quantity,
          unitValue: toMajorUnits(it.price_cents, currency),
          unitWeightInGrams: Math.max(1, Math.round(weightGrams / Math.max(1, items.length))),
        }))
      : [
          {
            name: 'Order goods',
            quantity: 1,
            unitValue: toMajorUnits(goodsCents, currency),
            unitWeightInGrams: weightGrams,
          },
        ];

  return {
    items: [
      {
        orderReference: ref,
        recipient: {
          address: {
            fullName: (shipTo.name ?? 'Customer').slice(0, 210),
            addressLine1: (shipTo.line1 ?? '').slice(0, 100),
            ...(shipTo.line2 && { addressLine2: shipTo.line2.slice(0, 100) }),
            city: (shipTo.city ?? '').slice(0, 100),
            ...(shipTo.state && { county: shipTo.state.slice(0, 100) }),
            ...(shipTo.postal && { postcode: shipTo.postal.slice(0, 20) }),
            countryCode: (shipTo.country ?? 'GB').toUpperCase().slice(0, 3),
          },
          ...(order.email && { emailAddress: order.email.slice(0, 254) }),
        },
        packages: [
          {
            weightInGrams: weightGrams,
            packageFormatIdentifier: packageFormatForWeightGrams(weightGrams),
            contents,
          },
        ],
        orderDate: isoOrderDate(order.created_at),
        subtotal: toMajorUnits(goodsCents, currency),
        shippingCostCharged: toMajorUnits(order.shipping_cents, currency),
        total: toMajorUnits(order.amount_total_cents, currency),
        currencyCode: currency.slice(0, 3),
        ...(order.tax_cents > 0 && { orderTax: toMajorUnits(order.tax_cents, currency) }),
      },
    ],
  };
}

interface CreateOrdersResponse {
  successCount?: number;
  errorsCount?: number;
  createdOrders?: Array<{
    orderIdentifier?: number;
    orderReference?: string;
    trackingNumber?: string;
  }>;
  failedOrders?: Array<{
    errors?: Array<{ errorMessage?: string; errorCode?: number }>;
  }>;
}

export async function pushOrderToClickDrop(
  apiKey: string,
  input: ClickDropPushInput,
): Promise<ClickDropResult<ClickDropPushResult>> {
  if (!shipToComplete(input.shipTo)) {
    return {
      ok: false,
      error: 'This order’s shipping address is incomplete — Click & Drop needs name, street, city, and country.',
    };
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/orders`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(buildClickDropCreatePayload(input)),
    });
  } catch {
    return { ok: false, error: 'Click & Drop is unreachable right now.', uncertain: true };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return {
      ok: false,
      error: `Click & Drop answered ${res.status} with an unreadable body.`,
      uncertain: res.ok || res.status >= 500,
    };
  }

  if (res.status === 401) {
    return { ok: false, error: 'Click & Drop rejected the API key.' };
  }

  const body = json as CreateOrdersResponse & { message?: string };
  if (!res.ok) {
    const failMsg =
      body.failedOrders?.[0]?.errors?.map((e) => e.errorMessage).filter(Boolean).join('; ') ||
      body.message;
    return {
      ok: false,
      error: failMsg || `Click & Drop answered ${res.status}.`,
      uncertain: res.status >= 500,
    };
  }

  const created = body.createdOrders?.[0];
  if (!created?.orderIdentifier) {
    const failMsg = body.failedOrders?.[0]?.errors
      ?.map((e) => e.errorMessage)
      .filter(Boolean)
      .join('; ');
    return {
      ok: false,
      error: failMsg || 'Click & Drop did not return an order id.',
      uncertain: (body.errorsCount ?? 0) > 0 && (body.successCount ?? 0) === 0 ? false : true,
    };
  }

  return {
    ok: true,
    value: {
      orderIdentifier: created.orderIdentifier,
      orderReference: created.orderReference ?? null,
      dashboardUrl: clickDropDashboardUrl(created.orderIdentifier),
      trackingNumber: created.trackingNumber ?? null,
    },
  };
}

export interface ClickDropRemoteStatus {
  orderIdentifier: number;
  orderReference: string | null;
  trackingNumber: string | null;
  printedOn: string | null;
  shippedOn: string | null;
  manifestedOn: string | null;
}

/** True when C&D shows a label printed, shipped, manifested, or a tracking number. */
export function clickDropLooksDespatched(status: ClickDropRemoteStatus): boolean {
  return !!(
    status.trackingNumber ||
    status.printedOn ||
    status.shippedOn ||
    status.manifestedOn
  );
}

interface GetOrderInfoResource {
  orderIdentifier?: number;
  orderReference?: string;
  trackingNumber?: string;
  printedOn?: string;
  shippedOn?: string;
  manifestedOn?: string;
}

/** Poll one C&D order by numeric identifier. */
export async function fetchClickDropOrder(
  apiKey: string,
  orderIdentifier: number,
): Promise<ClickDropResult<ClickDropRemoteStatus>> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/orders/${orderIdentifier}`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
    });
  } catch {
    return { ok: false, error: 'Click & Drop is unreachable right now.', uncertain: true };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return {
      ok: false,
      error: `Click & Drop answered ${res.status} with an unreadable body.`,
      uncertain: res.ok || res.status >= 500,
    };
  }

  if (res.status === 401) return { ok: false, error: 'Click & Drop rejected the API key.' };
  if (res.status === 404) return { ok: false, error: 'That Click & Drop order was not found.' };
  if (!res.ok) {
    const msg = (json as { message?: string }).message;
    return {
      ok: false,
      error: msg || `Click & Drop answered ${res.status}.`,
      uncertain: res.status >= 500,
    };
  }

  // Spec: array of GetOrderInfoResource for the path batch API.
  const row = (Array.isArray(json) ? json[0] : json) as GetOrderInfoResource | undefined;
  if (!row?.orderIdentifier) {
    return { ok: false, error: 'Click & Drop returned an empty order payload.' };
  }

  return {
    ok: true,
    value: {
      orderIdentifier: row.orderIdentifier,
      orderReference: row.orderReference ?? null,
      trackingNumber: row.trackingNumber?.trim() || null,
      printedOn: row.printedOn ?? null,
      shippedOn: row.shippedOn ?? null,
      manifestedOn: row.manifestedOn ?? null,
    },
  };
}

function shipToComplete(ship: ShippingAddress): boolean {
  return !!(ship.name && ship.line1 && ship.city && ship.country);
}

/** D1 stores naive UTC timestamps (`YYYY-MM-DD HH:MM:SS`). */
export function isoOrderDate(createdAt: string): string {
  const normalized = createdAt.includes('T') ? createdAt : createdAt.replace(' ', 'T');
  const withZone = /Z$|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
