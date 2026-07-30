import type { D1Database } from '@cloudflare/workers-types';
import type {
  PaymentProvider,
  CreateCheckoutParams,
  CheckoutResult,
  WebhookResult,
} from './provider';
import { createPendingPayment } from './lightning/pending';

export const DEMO_CHECKOUT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Demo payment provider — the automatic fallback when NO real rail is configured
 * (see getPaymentProvider). Collects nothing real: createCheckout stashes the
 * order snapshot in pending_payments (backend='demo') and sends the buyer to the
 * self-rendered /pay page, which simulates approval/decline and records the
 * order in-page (no webhook). Orders are tagged payment_method='demo', so they're
 * excluded from revenue and badged in the admin. Lets a freshly-deployed store be
 * exercised end-to-end before any Stripe key is added.
 */
export function createDemoProvider(db: D1Database): PaymentProvider {
  return {
    async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
      const subtotal = params.lineItems.reduce((s, li) => s + li.amountCents * li.quantity, 0);
      // The in-app step (/checkout) collects the address and the chosen rate before
      // we get here, so demo exercises the merchant's REAL configuration. Without a
      // selection there is nothing to charge — never fall back to options[0], which
      // silently billed whichever rate happened to sort first.
      const shippingCents = params.selectedShipping?.amountCents ?? 0;
      const publicId = params.metadata?.public_id ?? crypto.randomUUID();
      await createPendingPayment(db, {
        publicId,
        paymentHash: `demo_${publicId}`, // satisfies the table's unique session id
        backend: 'demo',
        bolt11: null,
        amountSat: null,
        amountTotalCents: subtotal + shippingCents,
        currency: params.lineItems[0]?.currency ?? 'usd',
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
        // Fixed 24h window: past it the pay page refuses to render, poll, or
        // settle the demo checkout (the guest token stays valid for the order
        // if one settled).
        expiresAt: new Date(Date.now() + DEMO_CHECKOUT_TTL_SECONDS * 1000).toISOString(),
      });
      // Point at the unified self-rendered pay page, absolute (origin from
      // successUrl). New checkouts address it by guest access token; the bare
      // public-id fallback only serves legacy in-flight sessions.
      return { url: new URL(`/pay/${params.accessToken ?? publicId}`, params.successUrl).href };
    },

    async verifyWebhook(): Promise<WebhookResult> {
      // Demo settles in-page (see /pay) — there is no external webhook.
      throw new Error('Demo provider has no webhook.');
    },
  };
}
