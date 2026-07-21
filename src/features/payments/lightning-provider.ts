import type { D1Database } from '@cloudflare/workers-types';
import type {
  PaymentProvider,
  CreateCheckoutParams,
  CheckoutResult,
  WebhookResult,
} from './provider';
import type { ShippingAddress } from '../orders/db';
import type { LightningBackend } from './lightning/backend';
import { getBtcRate, fiatCentsToSats } from './lightning/rate';
import {
  createPendingPayment,
  getPendingByHash,
  pendingToPaidOrder,
} from './lightning/pending';
import { getConfig } from '../../config';

export interface MintLightningOrderInput {
  origin: string;
  publicId: string;
  currency: string;
  subtotalCents: number;
  shippingCents?: number;
  /** Pre-serialized JSON cart snapshot: [{ id, q, n, p }]. */
  itemsJson?: string | null;
  email?: string | null;
  shippingAddress?: ShippingAddress | null;
  reservationId?: string | null;
}

/**
 * Mint a Lightning invoice for an order (subtotal + shipping → sats at spot) and
 * stash it as a pending payment. Shared by the no-shipping provider path
 * (createCheckout) and the own-checkout page (which adds shipping + address +
 * email). Returns the customer-facing /pay URL plus the raw invoice (so the
 * programmatic/agent path can pay it directly without the page).
 */
export async function mintLightningOrder(
  db: D1Database,
  backend: LightningBackend,
  input: MintLightningOrderInput,
): Promise<{ payUrl: string; bolt11: string; amountSat: number; paymentHash: string; expiresAt: string }> {
  const cfg = getConfig();
  const ln = cfg.payments.lightning;
  const shippingCents = input.shippingCents ?? 0;
  const totalCents = input.subtotalCents + shippingCents;

  const fiatPerBtc = await getBtcRate(input.currency, ln.rateUrl);
  const amountSat = fiatCentsToSats(totalCents, fiatPerBtc, input.currency);
  const expirySeconds = ln.invoiceExpiryMinutes * 60;

  const invoice = await backend.createInvoice({
    amountSat,
    description: `${cfg.storeName} — order ${input.publicId.slice(0, 8)}`,
    externalId: input.publicId,
    expirySeconds,
    // Per-provider path so Lightning settlements route to the Lightning verifier
    // even when another rail (e.g. Stripe) owns the default /api/webhook.
    webhookUrl: `${input.origin}/api/webhook/lightning`,
  });

  const expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString();
  await createPendingPayment(db, {
    publicId: input.publicId,
    paymentHash: invoice.paymentHash,
    backend: backend.name,
    bolt11: invoice.bolt11,
    amountSat,
    amountTotalCents: totalCents,
    currency: input.currency,
    email: input.email ?? null,
    itemsJson: input.itemsJson ?? null,
    shippingCents,
    shipAddressJson: input.shippingAddress ? JSON.stringify(input.shippingAddress) : null,
    reservationId: input.reservationId ?? null,
    expiresAt,
  });

  return {
    payUrl: `${input.origin}/pay/${input.publicId}`,
    bolt11: invoice.bolt11,
    amountSat,
    paymentHash: invoice.paymentHash,
    expiresAt,
  };
}

/**
 * Self-rendered Lightning checkout, implementing the outer PaymentProvider port
 * on top of a LightningBackend (phoenixd / LNbits). createCheckout here is the
 * NO-shipping path (digital goods etc.); when shipping is enabled the cart routes
 * through the own-checkout page (/checkout), which calls mintLightningOrder with
 * the collected address + shipping. Settlement is confirmed by re-polling the
 * node (the webhook is only a nudge). No refund — Lightning can't reverse.
 */
export function createLightningProvider(
  db: D1Database,
  backend: LightningBackend,
): PaymentProvider {
  return {
    async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
      const cfg = getConfig();
      const currency = params.lineItems[0]?.currency ?? cfg.currency;
      const subtotalCents = params.lineItems.reduce((s, l) => s + l.amountCents * l.quantity, 0);
      const publicId = params.metadata?.public_id ?? crypto.randomUUID();
      const origin = new URL(params.successUrl).origin;

      const minted = await mintLightningOrder(db, backend, {
        origin,
        publicId,
        currency,
        subtotalCents,
        itemsJson: params.orderItemsJson ?? null,
        reservationId: params.metadata?.reservation_id ?? null,
      });
      return {
        url: minted.payUrl,
        lightning: {
          invoice: minted.bolt11,
          amountSat: minted.amountSat,
          paymentHash: minted.paymentHash,
          expiresAt: minted.expiresAt,
        },
      };
    },

    async verifyWebhook(payload: string, headers: Headers): Promise<WebhookResult> {
      const evt = await backend.verifyWebhook(payload, headers);
      // The webhook is an untrusted nudge — re-poll the node for the truth.
      const status = await backend.getIncoming(evt.paymentHash);
      if (!status.paid) return { type: 'lightning.unconfirmed' };

      const pending = await getPendingByHash(db, evt.paymentHash);
      if (!pending) return { type: 'lightning.unknown' };
      return {
        type: 'lightning.paid',
        settlePendingPaymentId: evt.paymentHash,
        order: pendingToPaidOrder(pending),
      };
    },
    // No refund: Lightning payments can't be reversed in place.
  };
}
