import type { PaidOrderInput, ShippingAddress } from '../orders/db';

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
  /** Local pickup — no carrier delivery. Adapters record the mode as data
   *  (Stripe: rate metadata) rather than parsing the merchant's label text. */
  pickup?: boolean;
}

export interface CreateCheckoutParams {
  lineItems: CheckoutLineItem[];
  successUrl: string;
  cancelUrl: string;
  /** Small opaque values echoed back on the webhook (provider limits apply). */
  metadata?: Record<string, string>;
  /**
   * Guest access token for this checkout's /pay and /order capability URLs.
   * Allowlisted URL positions ONLY (self-rendered pay pages, hosted success_url)
   * — never placed in provider metadata or API fields.
   */
  accessToken?: string;
  /** Server-side cart snapshot for adapters that persist pending payment state. */
  orderItemsJson?: string;
  /** Show the "add promotion code" field on hosted checkout (codes live in Stripe). */
  allowPromotionCodes?: boolean;
  /** Compute sales tax / VAT via Stripe Tax (requires Stripe Tax activated). */
  automaticTax?: boolean;
  /** When set, collect a shipping address (allowed countries) + offer these rates. */
  shipping?: {
    addressCountries: string[];
    /** A "rest of world" zone matched: providers expand this into their own
     *  supported-country list rather than receiving an empty allow-list. */
    hasCatchAll?: boolean;
    options: ShippingOption[];
    /** Priced-at weight, snapshotted so the order can explain its shipping line. */
    shipmentWeightGrams?: number | null;
  };
  /**
   * Set when the in-app step has ALREADY collected an address and a chosen rate
   * (Lightning, OpenNode, Demo). Adapters charge and snapshot exactly this instead
   * of guessing from an unselected list — picking `options[0]` was how the demo
   * rail silently charged the wrong rate and OpenNode charged none at all.
   */
  selectedShipping?: {
    label: string;
    amountCents: number;
    weightGrams: number | null;
    /** How the order reaches the customer. Data, not inferred from the label
     *  text — a rate NAMED "Local pickup" could be priced as delivery. */
    deliveryMethod: 'pickup' | 'shipping';
    address: ShippingAddress;
    email: string | null;
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
  /** Present only when the event reports a refund made at the provider. */
  refundSync?: RefundSyncInput;
}

/**
 * A provider telling us how much of a payment it has refunded IN TOTAL.
 *
 * Cumulative and absolute, never a delta: that is what lets a duplicate or
 * out-of-order webhook be a no-op instead of double-counting. The order is
 * resolved by `providerPaymentId`, because refund events identify the charge
 * and its payment, not the checkout session that created it.
 */
export interface RefundSyncInput {
  /** Provider event id — the idempotency boundary for the whole sync. */
  eventId: string;
  providerPaymentId: string;
  providerChargeId?: string | null;
  cumulativeRefundedCents: number;
  currency: string | null;
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
  /**
   * Find the checkout session that produced a payment, so an order stored only
   * by session id can be correlated to a refund event that names the payment.
   *
   * OPTIONAL — only rails whose refund events identify a payment rather than a
   * session need it. Returns null when the provider knows of no such session.
   */
  findSessionIdForPayment?(providerPaymentId: string): Promise<string | null>;
}
