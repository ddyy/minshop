import type { D1Database } from '@cloudflare/workers-types';
import type {
  PaymentProvider,
  CreateCheckoutParams,
  CheckoutResult,
  WebhookResult,
} from './provider';
import { SUMUP_CHECKOUT_TTL_SECONDS } from './provider';
import {
  createPendingPayment,
  getPendingByHash,
  pendingToPaidOrder,
} from './lightning/pending';
import { toMajorUnits, toMinorUnits, currencyDecimals } from '../../money';

/**
 * SumUp — hosted card checkout. createCheckout returns a SumUp-hosted page URL;
 * settlement is confirmed by re-fetching the checkout (webhook/return are nudges).
 *
 * Auth: API key (Bearer). Merchant code is a public-ish merchant identifier stored
 * in settings (not the vault). Cart snapshot lives in pending_payments keyed by
 * the SumUp checkout id — same pattern as OpenNode/PayPal.
 */

export interface SumUpConfig {
  apiKey: string;
  merchantCode: string;
  /** Override API base (rare); default https://api.sumup.com */
  apiBase?: string;
}

const DEFAULT_BASE = 'https://api.sumup.com';

type SumUpCheckout = {
  id?: string;
  checkout_reference?: string;
  status?: string;
  amount?: number;
  currency?: string;
  hosted_checkout_url?: string;
  transaction_id?: string | null;
  transaction_code?: string | null;
  transactions?: Array<{ id?: string; transaction_code?: string }>;
};

function baseUrl(config: SumUpConfig): string {
  return (config.apiBase || DEFAULT_BASE).replace(/\/+$/, '');
}

async function sumupFetch<T>(
  config: SumUpConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${config.apiKey}`);
  headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl(config)}${path}`, { ...init, headers });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`SumUp ${path} failed (${response.status}): ${detail}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/** Exported for unit tests — SumUp amount is major units with currency decimals. */
export function sumupAmountValue(cents: number, currency: string): number {
  const major = toMajorUnits(cents, currency);
  const decimals = currencyDecimals(currency);
  // Avoid float drift (e.g. 19.9) by rounding to the currency's scale.
  const factor = 10 ** decimals;
  return Math.round(major * factor) / factor;
}

/** Exported for unit tests — authoritative amount/currency/status gate. */
export function assertExpectedSumUpCheckout(
  expected: { amount_total_cents: number; currency: string },
  checkout: SumUpCheckout,
): void {
  const status = (checkout.status ?? '').toUpperCase();
  if (status !== 'PAID') throw new Error(`SumUp checkout is ${checkout.status ?? 'unknown'}.`);
  if (checkout.amount == null || checkout.currency == null) {
    throw new Error('SumUp checkout is missing amount/currency.');
  }
  const amount = toMinorUnits(checkout.amount, checkout.currency);
  if (!Number.isFinite(amount) || amount !== expected.amount_total_cents) {
    throw new Error('SumUp checkout amount does not match the reserved order.');
  }
  if (checkout.currency.toUpperCase() !== expected.currency.toUpperCase()) {
    throw new Error('SumUp checkout currency does not match the reserved order.');
  }
}

export async function retrieveSumUpCheckout(
  config: SumUpConfig,
  checkoutId: string,
): Promise<SumUpCheckout> {
  return sumupFetch<SumUpCheckout>(config, `/v0.1/checkouts/${encodeURIComponent(checkoutId)}`);
}

/**
 * Re-fetch a checkout and settle when PAID. Used by the return URL and the
 * CHECKOUT_STATUS_CHANGED webhook — both are untrusted nudges; the API is authority.
 */
export async function settleSumUpCheckout(
  db: D1Database,
  config: SumUpConfig,
  checkoutId: string,
): Promise<WebhookResult> {
  const pending = await getPendingByHash(db, checkoutId);
  if (!pending) return { type: 'sumup.unknown' };

  if (pending.status === 'settled') {
    return {
      type: 'sumup.paid',
      settlePendingPaymentId: checkoutId,
      order: pendingToPaidOrder(pending),
    };
  }

  const checkout = await retrieveSumUpCheckout(config, checkoutId);
  const status = (checkout.status ?? '').toUpperCase();
  if (status !== 'PAID') {
    return {
      type: `sumup.${(checkout.status ?? 'pending').toLowerCase()}`,
      releaseReservationId: status === 'FAILED' || status === 'EXPIRED' ? pending.public_id : undefined,
    };
  }

  assertExpectedSumUpCheckout(pending, checkout);
  const tx = checkout.transactions?.[0];
  const paymentId =
    checkout.transaction_code ||
    checkout.transaction_id ||
    tx?.transaction_code ||
    tx?.id ||
    checkout.id ||
    checkoutId;
  return {
    type: 'sumup.paid',
    settlePendingPaymentId: checkoutId,
    order: { ...pendingToPaidOrder(pending), providerPaymentId: String(paymentId) },
  };
}

export function createSumUpProvider(db: D1Database, config: SumUpConfig): PaymentProvider {
  return {
    async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
      const currency = (params.lineItems[0]?.currency ?? 'eur').toUpperCase();
      if (params.lineItems.some((line) => line.currency.toUpperCase() !== currency)) {
        throw new Error('SumUp checkout requires a single currency.');
      }
      const shippingCents = params.selectedShipping?.amountCents ?? 0;
      const totalCents =
        params.lineItems.reduce((sum, line) => sum + line.amountCents * line.quantity, 0) +
        shippingCents;
      const origin = new URL(params.successUrl).origin;
      const publicId = params.metadata?.public_id ?? crypto.randomUUID();

      // Customer return settles (or confirms) then redirects to the order page.
      // Include our public_id so we can resolve the SumUp checkout id from pending.
      const redirectUrl = new URL('/api/sumup/return', origin);
      redirectUrl.searchParams.set('success', params.successUrl);
      redirectUrl.searchParams.set('ref', publicId);

      const checkout = await sumupFetch<SumUpCheckout>(config, '/v0.1/checkouts', {
        method: 'POST',
        body: JSON.stringify({
          checkout_reference: publicId,
          amount: sumupAmountValue(totalCents, currency),
          currency,
          merchant_code: config.merchantCode,
          description: `Order ${publicId.slice(0, 8)}`,
          // Per-checkout status POST — authority is still GET /checkouts/:id.
          return_url: `${origin}/api/webhook/sumup`,
          redirect_url: redirectUrl.href,
          hosted_checkout: { enabled: true },
        }),
      });

      const checkoutId = checkout.id;
      const url = checkout.hosted_checkout_url;
      if (!checkoutId || !url) throw new Error('SumUp returned no hosted checkout URL.');

      const expiresAt = new Date(Date.now() + SUMUP_CHECKOUT_TTL_SECONDS * 1000).toISOString();
      await createPendingPayment(db, {
        publicId,
        paymentHash: checkoutId,
        backend: 'sumup',
        bolt11: null,
        amountSat: null,
        amountTotalCents: totalCents,
        currency,
        email: params.selectedShipping?.email ?? null,
        itemsJson: params.orderItemsJson ?? null,
        shippingCents,
        shippingLabel: params.selectedShipping?.label ?? null,
        shippingWeightGrams: params.selectedShipping?.weightGrams ?? null,
        deliveryMethod: params.selectedShipping?.deliveryMethod ?? null,
        shipAddressJson: params.selectedShipping
          ? JSON.stringify(params.selectedShipping.address)
          : null,
        reservationId: params.metadata?.reservation_id ?? null,
        expiresAt,
      });

      return { url };
    },

    async verifyWebhook(payload: string, _headers: Headers): Promise<WebhookResult> {
      // SumUp posts { event_type, id }. Always re-fetch — payload is untrusted.
      let event: { event_type?: string; id?: string };
      try {
        event = JSON.parse(payload) as { event_type?: string; id?: string };
      } catch {
        throw new Error('SumUp webhook payload is not JSON.');
      }
      if (!event.id) throw new Error('SumUp webhook is missing checkout id.');
      if (event.event_type && event.event_type !== 'CHECKOUT_STATUS_CHANGED') {
        return { type: event.event_type };
      }
      return settleSumUpCheckout(db, config, event.id);
    },
    // Refunds: SumUp transaction refunds need the transaction code and a
    // separate flow — handle in the SumUp dashboard for now (same as OpenNode).
  };
}
