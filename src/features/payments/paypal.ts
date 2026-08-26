import type { D1Database } from '@cloudflare/workers-types';
import type { CreateCheckoutParams, CheckoutResult, PaymentProvider, WebhookResult } from './provider';
import { createPendingPayment, getPendingByHash, pendingToPaidOrder } from './lightning/pending';
import { toMajorUnits, toMinorUnits, currencyDecimals } from '../../money';

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  webhookId: string;
  /** Sandbox: https://api-m.sandbox.paypal.com — live default when omitted. */
  apiBase?: string;
}

interface PayPalCapture {
  id: string;
  status: string;
  amount: { value: string; currency_code: string };
}

type PayPalOrderBody = {
  status?: string;
  purchase_units?: Array<{ payments?: { captures?: PayPalCapture[] } }>;
};

let cachedToken: { key: string; token: string; expiresAt: number } | null = null;

function baseUrl(config: PayPalConfig): string {
  return (config.apiBase || 'https://api-m.paypal.com').replace(/\/+$/, '');
}

async function accessToken(config: PayPalConfig): Promise<string> {
  const key = `${config.clientId}@${baseUrl(config)}`;
  if (cachedToken?.key === key && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }
  const response = await fetch(`${baseUrl(config)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!response.ok) throw new Error(`PayPal OAuth failed (${response.status}).`);
  const body = await response.json() as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error('PayPal OAuth returned no access token.');
  cachedToken = {
    key,
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 300) * 1000,
  };
  return body.access_token;
}

async function paypalFetch<T>(
  config: PayPalConfig,
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {},
): Promise<T> {
  const token = await accessToken(config);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.set('content-type', 'application/json');
  if (init.idempotencyKey) headers.set('PayPal-Request-Id', init.idempotencyKey);
  const response = await fetch(`${baseUrl(config)}${path}`, { ...init, headers });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`PayPal ${path} failed (${response.status}): ${detail}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/** Exported for unit tests — PayPal amount strings must match currency decimals. */
export function paypalAmountValue(cents: number, currency: string): string {
  return toMajorUnits(cents, currency).toFixed(currencyDecimals(currency));
}

function captureFromOrder(body: PayPalOrderBody): PayPalCapture {
  const capture = body.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) throw new Error('PayPal returned no capture.');
  return capture;
}

/** Exported for unit tests — authoritative amount/currency gate before settlement. */
export function assertExpectedPayPalCapture(
  expected: { amount_total_cents: number; currency: string },
  capture: PayPalCapture,
): void {
  const amount = toMinorUnits(Number(capture.amount.value), capture.amount.currency_code);
  if (!Number.isFinite(amount) || amount !== expected.amount_total_cents) {
    throw new Error('PayPal capture amount does not match the reserved order.');
  }
  if (capture.amount.currency_code.toUpperCase() !== expected.currency.toUpperCase()) {
    throw new Error('PayPal capture currency does not match the reserved order.');
  }
  if (capture.status !== 'COMPLETED') throw new Error(`PayPal capture is ${capture.status}.`);
}

async function loadCapturedOrder(config: PayPalConfig, orderId: string): Promise<PayPalOrderBody> {
  return paypalFetch<PayPalOrderBody>(
    config,
    `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
  );
}

/**
 * Capture (or re-load) a PayPal order after buyer approval. Used by the return
 * URL; the webhook is a parallel settle path for the same pending row.
 */
export async function capturePayPalOrder(
  db: D1Database,
  config: PayPalConfig,
  orderId: string,
): Promise<WebhookResult> {
  const pending = await getPendingByHash(db, orderId);
  if (!pending) throw new Error('Unknown PayPal order.');

  // Return URL and webhook can race; a second capture must not invent a second order.
  if (pending.status === 'settled') {
    return {
      type: 'paypal.capture.completed',
      settlePendingPaymentId: orderId,
      order: pendingToPaidOrder(pending),
    };
  }

  let response: PayPalOrderBody;
  try {
    response = await paypalFetch<PayPalOrderBody>(
      config,
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: 'POST',
        body: '{}',
        idempotencyKey: `pp-capture-${orderId}`.slice(0, 38),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/ORDER_ALREADY_CAPTURED|422|400/.test(message)) throw error;
    response = await loadCapturedOrder(config, orderId);
  }

  const capture = captureFromOrder(response);
  assertExpectedPayPalCapture(pending, capture);
  return {
    type: 'paypal.capture.completed',
    settlePendingPaymentId: orderId,
    order: { ...pendingToPaidOrder(pending), providerPaymentId: capture.id },
  };
}

export function createPayPalProvider(db: D1Database, config: PayPalConfig): PaymentProvider {
  return {
    async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
      const currency = (params.lineItems[0]?.currency ?? 'USD').toUpperCase();
      if (params.lineItems.some((line) => line.currency.toUpperCase() !== currency)) {
        throw new Error('PayPal checkout requires a single currency.');
      }
      const shippingCents = params.selectedShipping?.amountCents ?? 0;
      const totalCents = params.lineItems.reduce(
        (sum, line) => sum + line.amountCents * line.quantity,
        shippingCents,
      );
      const publicId = params.metadata?.public_id ?? crypto.randomUUID();
      const returnUrl = new URL('/api/paypal/return', new URL(params.successUrl).origin);
      returnUrl.searchParams.set('success', params.successUrl);
      const order = await paypalFetch<{
        id?: string;
        links?: Array<{ rel: string; href: string }>;
      }>(config, '/v2/checkout/orders', {
        method: 'POST',
        idempotencyKey: `pp-order-${publicId}`.slice(0, 38),
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{
            reference_id: publicId,
            custom_id: publicId,
            amount: {
              currency_code: currency,
              value: paypalAmountValue(totalCents, currency),
              breakdown: {
                item_total: {
                  currency_code: currency,
                  value: paypalAmountValue(totalCents - shippingCents, currency),
                },
                shipping: {
                  currency_code: currency,
                  value: paypalAmountValue(shippingCents, currency),
                },
              },
            },
            items: params.lineItems.map((line) => ({
              name: line.name.slice(0, 127),
              quantity: String(line.quantity),
              unit_amount: {
                currency_code: currency,
                value: paypalAmountValue(line.amountCents, currency),
              },
              category: 'PHYSICAL_GOODS',
            })),
          }],
          payment_source: {
            paypal: {
              experience_context: {
                user_action: 'PAY_NOW',
                shipping_preference: 'NO_SHIPPING',
                return_url: returnUrl.href,
                cancel_url: params.cancelUrl,
              },
            },
          },
        }),
      });
      const approveUrl = order.links?.find((link) => link.rel === 'payer-action' || link.rel === 'approve')?.href;
      if (!order.id || !approveUrl) throw new Error('PayPal returned no approval link.');

      await createPendingPayment(db, {
        publicId,
        paymentHash: order.id,
        backend: 'paypal',
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
        shipAddressJson: params.selectedShipping ? JSON.stringify(params.selectedShipping.address) : null,
        reservationId: params.metadata?.reservation_id ?? null,
        expiresAt: null,
      });
      return { url: approveUrl };
    },

    async verifyWebhook(payload: string, headers: Headers): Promise<WebhookResult> {
      const required = [
        'paypal-auth-algo',
        'paypal-cert-url',
        'paypal-transmission-id',
        'paypal-transmission-sig',
        'paypal-transmission-time',
      ];
      if (required.some((name) => !headers.get(name))) {
        throw new Error('Missing PayPal signature headers.');
      }
      const event = JSON.parse(payload) as {
        event_type?: string;
        resource?: PayPalCapture & {
          supplementary_data?: { related_ids?: { order_id?: string } };
        };
      };
      const verification = await paypalFetch<{ verification_status?: string }>(
        config,
        '/v1/notifications/verify-webhook-signature',
        {
          method: 'POST',
          body: JSON.stringify({
            auth_algo: headers.get('paypal-auth-algo'),
            cert_url: headers.get('paypal-cert-url'),
            transmission_id: headers.get('paypal-transmission-id'),
            transmission_sig: headers.get('paypal-transmission-sig'),
            transmission_time: headers.get('paypal-transmission-time'),
            webhook_id: config.webhookId,
            webhook_event: event,
          }),
        },
      );
      if (verification.verification_status !== 'SUCCESS') {
        throw new Error('Invalid PayPal webhook signature.');
      }
      if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED') {
        return { type: event.event_type ?? 'paypal.unknown' };
      }
      const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
      if (!orderId || !event.resource) throw new Error('PayPal webhook is missing its order id.');
      const pending = await getPendingByHash(db, orderId);
      if (!pending) return { type: 'paypal.capture.unknown' };
      if (pending.status === 'settled') {
        return {
          type: 'paypal.capture.completed',
          settlePendingPaymentId: orderId,
          order: { ...pendingToPaidOrder(pending), providerPaymentId: event.resource.id },
        };
      }
      assertExpectedPayPalCapture(pending, event.resource);
      return {
        type: 'paypal.capture.completed',
        settlePendingPaymentId: orderId,
        order: { ...pendingToPaidOrder(pending), providerPaymentId: event.resource.id },
      };
    },

    async refund(providerSessionId: string): Promise<void> {
      // Admin refunds pass provider_session_id (= PayPal Checkout order id).
      const order = await loadCapturedOrder(config, providerSessionId);
      const capture = captureFromOrder(order);
      await paypalFetch(
        config,
        `/v2/payments/captures/${encodeURIComponent(capture.id)}/refund`,
        {
          method: 'POST',
          body: '{}',
          idempotencyKey: `pp-refund-${capture.id}`.slice(0, 38),
        },
      );
    },
  };
}
