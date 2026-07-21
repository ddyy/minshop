import type { PaidOrderInput } from '../orders/db';

/** Keep anonymous hosted inventory holds short and aligned with provider expiry. */
export const STRIPE_CHECKOUT_TTL_SECONDS = 30 * 60;
export const OPENNODE_CHECKOUT_TTL_SECONDS = 10 * 60;
export const RESERVATION_EXPIRY_GRACE_SECONDS = 5 * 60;

/**
 * Payment provider port (ports-and-adapters). The checkout + webhook routes
 * depend on this interface, not on Stripe directly — swapping to Paddle / Lemon
 * Squeezy means writing one new adapter, no route changes.
 */

export interface CheckoutLineItem {
  name: string;
  amountCents: number;
  currency: string;
  quantity: number;
  /** Absolute, publicly-reachable image URL shown on the hosted checkout. */
  imageUrl?: string;
}

export interface ShippingOption {
  label: string;
  amountCents: number;
}

export interface CreateCheckoutParams {
  lineItems: CheckoutLineItem[];
  successUrl: string;
  cancelUrl: string;
  /** Small opaque values echoed back on the webhook (provider limits apply). */
  metadata?: Record<string, string>;
  /** Server-side cart snapshot for adapters that persist pending payment state. */
  orderItemsJson?: string;
  /** Show the "add promotion code" field on hosted checkout (codes live in Stripe). */
  allowPromotionCodes?: boolean;
  /** Compute sales tax / VAT via Stripe Tax (requires Stripe Tax activated). */
  automaticTax?: boolean;
  /** When set, collect a shipping address (allowed countries) + offer these rates. */
  shipping?: {
    addressCountries: string[];
    options: ShippingOption[];
  };
}

export interface CheckoutResult {
  /** Hosted checkout URL to redirect the customer to (or, for Lightning, the
   *  self-rendered /pay page). Always present — the human fallback. */
  url: string;
  /**
   * Lightning only: the payable BOLT11 invoice + metadata, so a programmatic
   * caller (an agent with a wallet) can pay WITHOUT visiting the /pay page.
   * Undefined for hosted-redirect providers (Stripe/OpenNode) — those require a
   * human on the hosted page, so there's nothing machine-payable to expose.
   */
  lightning?: {
    /** BOLT11 invoice string (`lnbc…`). */
    invoice: string;
    amountSat: number;
    paymentHash: string;
    /** ISO timestamp after which the invoice is dead. */
    expiresAt: string;
  };
}

export interface WebhookResult {
  /** Provider event type, for logging/branching. */
  type: string;
  /** Abandoned/expired checkout whose held inventory should be released. */
  releaseReservationId?: string;
  /** Delayed payment started; protect its hold from ordinary checkout expiry. */
  pendingReservationId?: string;
  /** Pending-payment row to mark settled only after the paid order commits. */
  settlePendingPaymentId?: string;
  /** Present only when the event represents a completed, paid checkout. */
  order?: PaidOrderInput;
}

export interface PaymentProvider {
  createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult>;
  /**
   * Verify an incoming webhook and normalize it. Implementations read their own
   * signature header from `headers`. Throws on an invalid/forged signature.
   */
  verifyWebhook(payload: string, headers: Headers): Promise<WebhookResult>;
  /**
   * Fully refund the payment for a provider session id. Throws on failure.
   * OPTIONAL — Lightning has no native refund (you'd pay a new invoice back to
   * the buyer), so those adapters omit it; callers must handle its absence.
   */
  refund?(providerSessionId: string): Promise<void>;
}
