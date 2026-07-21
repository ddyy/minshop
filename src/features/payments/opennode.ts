import type { D1Database } from '@cloudflare/workers-types';
import type {
  PaymentProvider,
  CreateCheckoutParams,
  CheckoutResult,
  WebhookResult,
} from './provider';
import { OPENNODE_CHECKOUT_TTL_SECONDS } from './provider';
import {
  createPendingPayment,
  getPendingByHash,
  pendingToPaidOrder,
} from './lightning/pending';
import { toMajorUnits } from '../../money';

/**
 * OpenNode — hosted Lightning checkout (custodial processor). Behaves like Stripe:
 * createCheckout returns a hosted page URL; the webhook reports settlement.
 * OpenNode does its own fiat→BTC conversion, so no rate lookup here.
 *
 * Its webhook can't echo a cart snapshot, so (unlike Stripe) we stash one in
 * pending_payments keyed by the charge id and read it back on settlement.
 * Webhooks are verified by HMAC: `hashed_order == HMAC-SHA256(api_key, id)`.
 */
const DEFAULT_BASE = 'https://api.opennode.com';

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createOpenNodeProvider(
  db: D1Database,
  apiKey: string,
  baseUrl: string = DEFAULT_BASE,
): PaymentProvider {
  const base = baseUrl.replace(/\/+$/, '');

  return {
    async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
      const currency = params.lineItems[0]?.currency ?? 'usd';
      const totalCents = params.lineItems.reduce((s, l) => s + l.amountCents * l.quantity, 0);
      const origin = new URL(params.successUrl).origin;
      const publicId = params.metadata?.public_id ?? crypto.randomUUID();

      const res = await fetch(`${base}/v1/charges`, {
        method: 'POST',
        headers: { Authorization: apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          amount: toMajorUnits(totalCents, currency), // OpenNode wants the fiat main-unit amount (currency-scaled)
          currency: currency.toUpperCase(),
          description: `Order ${publicId.slice(0, 8)}`,
          order_id: publicId,
          // Per-provider route so OpenNode is verified as OpenNode even when it
          // ISN'T the store's default rail (the bare /api/webhook route verifies
          // as the DEFAULT provider — would reject an OpenNode callback if e.g.
          // Stripe is default). Matches the Lightning webhook pattern.
          callback_url: `${origin}/api/webhook/opennode`,
          success_url: params.successUrl,
          auto_settle: false,
          ttl: Math.floor(OPENNODE_CHECKOUT_TTL_SECONDS / 60),
        }),
      });
      if (!res.ok) throw new Error(`OpenNode charge failed: ${res.status}`);
      const j = (await res.json()) as {
        data?: { id?: string; hosted_checkout_url?: string };
      };
      const id = j.data?.id;
      const url = j.data?.hosted_checkout_url;
      if (!id || !url) throw new Error('OpenNode: malformed charge response');

      // Stash the cart snapshot — OpenNode's webhook won't return it.
      await createPendingPayment(db, {
        publicId,
        paymentHash: id, // charge id is the settlement key for OpenNode
        backend: 'opennode',
        bolt11: null,
        amountSat: null,
        amountTotalCents: totalCents,
        currency,
        email: null,
        itemsJson: params.orderItemsJson ?? null,
        reservationId: params.metadata?.reservation_id ?? null,
        expiresAt: null,
      });

      return { url };
    },

    async verifyWebhook(payload: string): Promise<WebhookResult> {
      // OpenNode posts application/x-www-form-urlencoded.
      const form = new URLSearchParams(payload);
      const id = form.get('id');
      const status = form.get('status');
      const hashedOrder = form.get('hashed_order');
      if (!id || !hashedOrder) throw new Error('OpenNode: webhook missing id/hashed_order');

      const expected = await hmacSha256Hex(apiKey, id);
      if (hashedOrder.toLowerCase() !== expected) {
        throw new Error('OpenNode: bad webhook signature');
      }
      if (status !== 'paid') {
        const pending = status === 'expired' ? await getPendingByHash(db, id) : null;
        return {
          type: `opennode.${status ?? 'unknown'}`,
          releaseReservationId: pending?.public_id,
        };
      }

      const pending = await getPendingByHash(db, id);
      if (!pending) return { type: 'opennode.unknown' };
      return {
        type: 'opennode.paid',
        settlePendingPaymentId: id,
        order: pendingToPaidOrder(pending),
      };
    },
    // No refund: OpenNode refunds require a payout address — handle off-platform.
  };
}
