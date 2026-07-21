import type { D1Database } from '@cloudflare/workers-types';
import type {
  PaymentProvider,
  CreateCheckoutParams,
  CheckoutResult,
  WebhookResult,
} from './provider';
import { createPendingPayment } from './lightning/pending';

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
      // No address is collected in demo, so just take the first offered rate (if any).
      const shippingCents = params.shipping?.options?.[0]?.amountCents ?? 0;
      const publicId = params.metadata?.public_id ?? crypto.randomUUID();
      await createPendingPayment(db, {
        publicId,
        paymentHash: `demo_${publicId}`, // satisfies the table's unique session id
        backend: 'demo',
        bolt11: null,
        amountSat: null,
        amountTotalCents: subtotal + shippingCents,
        currency: params.lineItems[0]?.currency ?? 'usd',
        email: null,
        itemsJson: params.orderItemsJson ?? null,
        shippingCents,
        shipAddressJson: null,
        expiresAt: null,
      });
      // Point at the unified self-rendered pay page, absolute (origin from successUrl).
      return { url: new URL(`/pay/${publicId}`, params.successUrl).href };
    },

    async verifyWebhook(): Promise<WebhookResult> {
      // Demo settles in-page (see /pay) — there is no external webhook.
      throw new Error('Demo provider has no webhook.');
    },
  };
}
