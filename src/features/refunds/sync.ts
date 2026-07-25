// Applying a provider's refund event to an order.
//
// The order of operations matters more than it looks. The verified event is
// persisted BEFORE the order is resolved, so an event we can't correlate yet
// (a legacy order with no stored PaymentIntent) is never lost and the provider
// is never made to retry a perfectly valid event forever. Only a failure to
// persist is worth a 500 — that is the one case where a retry helps.

import type { RefundSyncInput } from '../payments/provider';
// Explicit .ts extension: this module is imported directly by
// scripts/test-refunds.mjs under node's type stripping, which does not resolve
// extensionless relative paths. allowImportingTsExtensions is on, so Vite and
// astro check both accept it.
import { syncProviderRefund, openRefundReview } from './db.ts';

export type SyncOutcome =
  /** Applied; `deltaCents` is how much the provider total advanced by. */
  | { status: 'processed'; orderId: number; deltaCents: number; fullyRefunded: boolean }
  /** Valid, already known — a duplicate or out-of-order event. */
  | { status: 'no_change'; orderId: number }
  /** Valid but not correlated to an order yet; kept for reconciliation. */
  | { status: 'unmatched' }
  /** Correlated but conflicting; the order is flagged and totals untouched. */
  | { status: 'review'; orderId: number; reason: string };

/**
 * Persist a verified refund event. Idempotent on the provider's event id, so a
 * redelivery reuses the stored row rather than creating a second one.
 *
 * Throws if the write fails — the caller should return a 5xx so the provider
 * retries, because at that point we hold no record of the event at all.
 */
export async function persistRefundEvent(
  db: D1Database,
  provider: string,
  input: RefundSyncInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO refund_sync_events (
         provider_event_id, provider, provider_payment_id, provider_charge_id,
         cumulative_refunded_cents, currency, status, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
       ON CONFLICT(provider_event_id) DO NOTHING`,
    )
    .bind(
      input.eventId,
      provider,
      input.providerPaymentId,
      input.providerChargeId ?? null,
      input.cumulativeRefundedCents,
      input.currency,
    )
    .run();
}

async function markEvent(
  db: D1Database,
  eventId: string,
  status: string,
  error?: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE refund_sync_events
          SET status = ?,
              attempts = attempts + 1,
              last_error = ?,
              processed_at = CASE WHEN ? = 'processed' THEN datetime('now') ELSE processed_at END
        WHERE provider_event_id = ?`,
    )
    .bind(status, error ?? null, status, eventId)
    .run();
}

/**
 * Correlate a persisted event to an order and synchronise the provider total.
 *
 * Safe to call repeatedly for the same event — that is exactly what the
 * reconciliation Retry action does.
 */
export async function applyRefundEvent(
  db: D1Database,
  provider: string,
  input: RefundSyncInput,
): Promise<SyncOutcome> {
  const order = await db
    .prepare(
      `SELECT id, currency, payment_method, amount_total_cents,
              provider_refunded_cents, external_refunded_cents
         FROM orders WHERE provider_payment_id = ?`,
    )
    .bind(input.providerPaymentId)
    .first<{
      id: number;
      currency: string;
      payment_method: string | null;
      amount_total_cents: number;
      provider_refunded_cents: number;
      external_refunded_cents: number;
    }>();

  if (!order) {
    // Legacy orders settled before the PaymentIntent was stored land here. The
    // event stays queued for the admin reconciliation panel, which can retry it
    // after backfilling the id rather than losing the refund entirely.
    await markEvent(db, input.eventId, 'unmatched');
    return { status: 'unmatched' };
  }

  // A refund in a different currency than the order was taken in means the
  // event and the order disagree about what was actually charged. Adding the
  // number anyway would silently corrupt the total, so flag it and touch nothing.
  if (input.currency && order.currency && input.currency.toLowerCase() !== order.currency.toLowerCase()) {
    const reason = 'currency_mismatch';
    await openRefundReview(db, order.id, reason);
    await markEvent(db, input.eventId, 'failed', reason);
    return { status: 'review', orderId: order.id, reason };
  }

  const result = await syncProviderRefund(db, {
    orderId: order.id,
    cumulativeRefundedCents: input.cumulativeRefundedCents,
    provider,
    idempotencyKey: `${provider}:event:${input.eventId}`,
    providerRefundId: input.providerChargeId ?? null,
    providerEventId: input.eventId,
    reason: 'Synchronised from a provider refund event',
  });

  if (!result.ok) {
    await markEvent(db, input.eventId, 'unmatched');
    return { status: 'unmatched' };
  }

  await markEvent(db, input.eventId, 'processed');

  // The provider's own total plus what we recorded by hand exceeds the order.
  // Both numbers are individually plausible, so neither is discarded — the
  // aggregate is clamped by the generated column and a human decides.
  const totalAfter =
    Math.max(order.provider_refunded_cents, input.cumulativeRefundedCents) +
    order.external_refunded_cents;
  if (totalAfter > order.amount_total_cents) {
    const reason = 'exceeds_order_total';
    await openRefundReview(db, order.id, reason);
    return { status: 'review', orderId: order.id, reason };
  }

  if (!result.advanced) return { status: 'no_change', orderId: order.id };
  return {
    status: 'processed',
    orderId: order.id,
    deltaCents: result.deltaCents,
    fullyRefunded: result.fullyRefunded,
  };
}
