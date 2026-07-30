/**
 * The label-purchase state machine (see migration 0034). Dependency-free on
 * purpose, matching outboxStore: the D1 integration script exercises this SQL
 * against a real database, where the claim semantics actually live.
 *
 * The invariants, in one place:
 * - One row per order (PRIMARY KEY) — the claim that stops double purchases.
 * - Quoting and claiming are CONDITIONAL writes gated on the order still being
 *   paid, unfulfilled, and a delivery (not pickup) order — the page's display
 *   logic is convenience, these guards are the enforcement.
 * - An ambiguous provider outcome parks the row in 'uncertain' and nothing
 *   retries it automatically; provider reconciliation or an explicit
 *   risk-bearing override is required.
 * - Every settled submitted attempt is copied to shipping_label_attempts before
 *   the mutable active row can be reused or removed.
 */

import type { D1Database } from '@cloudflare/workers-types';

export type LabelStatus = 'quoted' | 'purchasing' | 'purchased' | 'failed' | 'uncertain';

/**
 * How long a 'purchasing' row is presumed to have a live request behind it.
 * This is a UI signal ONLY — "show progress" vs "offer reconciliation". It
 * never reopens the order: a submitted purchase may still complete at Shippo
 * long after any local timeout, so the only thing that can settle it is
 * Shippo's own answer (reconcileWithProvider in the route), not a lease.
 */
export const PURCHASE_LEASE_SECONDS = 120;

/** A purchasing row whose lease has expired — probably crashed, POSSIBLY still
 *  completing. Reconcile against the provider; never assume. */
export function isPurchaseStale(record: Pick<LabelRecord, 'status' | 'updated_at'>): boolean {
  if (record.status !== 'purchasing') return false;
  const updated = Date.parse(`${record.updated_at.replace(' ', 'T')}Z`);
  return !Number.isFinite(updated) || Date.now() - updated >= PURCHASE_LEASE_SECONDS * 1000;
}

export interface LabelRecord {
  order_id: number;
  status: LabelStatus;
  shipment_id: string;
  rate_id: string | null;
  transaction_id: string | null;
  provider: string | null;
  service: string | null;
  amount_cents: number | null;
  tracking_number: string | null;
  label_url: string | null;
  error: string | null;
  claim_token: string | null;
  updated_at: string;
}

export type LabelAttemptOutcome = 'purchased' | 'refunded' | 'failed' | 'force_discarded';

export interface LabelAttemptRecord {
  id: number;
  order_id: number;
  claim_token: string;
  outcome: LabelAttemptOutcome;
  shipment_id: string;
  rate_id: string | null;
  transaction_id: string | null;
  provider: string | null;
  service: string | null;
  amount_cents: number | null;
  tracking_number: string | null;
  label_url: string | null;
  error: string | null;
  created_at: string;
  settled_at: string;
}

/** The order must still be worth labelling: paid, unfulfilled, not a pickup. */
const ORDER_ELIGIBLE = `EXISTS (
  SELECT 1 FROM orders
   WHERE id = ?1 AND status = 'paid' AND fulfillment_status = 'unfulfilled'
     AND delivery_method = 'shipping'
)`;

export async function getLabelRecord(db: D1Database, orderId: number): Promise<LabelRecord | null> {
  return db
    .prepare('SELECT * FROM shipping_labels WHERE order_id = ?')
    .bind(orderId)
    .first<LabelRecord>();
}

export async function listLabelAttempts(
  db: D1Database,
  orderId: number,
  limit = 25,
): Promise<LabelAttemptRecord[]> {
  const result = await db
    .prepare(
      `SELECT *
         FROM shipping_label_attempts
        WHERE order_id = ?1
        ORDER BY settled_at DESC, id DESC
        LIMIT ?2`,
    )
    .bind(orderId, limit)
    .all<LabelAttemptRecord>();
  return result.results;
}

/**
 * Record a fresh quote. Succeeds only while no purchase has been attempted:
 * an existing quoted/failed row is replaced (new rates supersede old), but a
 * purchasing/uncertain/purchased row refuses — those represent money.
 */
export async function recordQuote(
  db: D1Database,
  orderId: number,
  shipmentId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO shipping_labels (order_id, status, shipment_id)
       SELECT ?1, 'quoted', ?2 WHERE ${ORDER_ELIGIBLE}
       ON CONFLICT(order_id) DO UPDATE SET
         shipment_id = excluded.shipment_id,
         status = 'quoted',
         rate_id = NULL,
         transaction_id = NULL,
         provider = NULL,
         service = NULL,
         amount_cents = NULL,
         tracking_number = NULL,
         label_url = NULL,
         claim_token = NULL,
         error = NULL,
         updated_at = datetime('now')
       WHERE shipping_labels.status IN ('quoted', 'failed')
       RETURNING order_id`,
    )
    .bind(orderId, shipmentId)
    .first();
  return row != null;
}

/**
 * Claim the purchase BEFORE the provider call. Exactly one concurrent submit
 * can flip quoted → purchasing; the loser's conditional UPDATE matches nothing.
 * Returns the shipment to buy from — never the one posted by the browser.
 */
export async function claimPurchase(
  db: D1Database,
  orderId: number,
  rateId: string,
): Promise<{ shipmentId: string; claimToken: string } | null> {
  // A fresh random token per claim: status alone cannot fence attempts across
  // time. A claim that outlives its lease, gets discarded, and completes late
  // must find that its token no longer matches the (recreated) row — writing
  // its label into a newer attempt's row would fulfil the order twice over.
  const claimToken = crypto.randomUUID();
  const row = await db
    .prepare(
      `UPDATE shipping_labels
          SET status = 'purchasing', rate_id = ?2, claim_token = ?3, updated_at = datetime('now')
        WHERE order_id = ?1 AND status = 'quoted' AND ${ORDER_ELIGIBLE}
        RETURNING shipment_id`,
    )
    .bind(orderId, rateId, claimToken)
    .first<{ shipment_id: string }>();
  return row ? { shipmentId: row.shipment_id, claimToken } : null;
}

export interface PurchasedRecord {
  transactionId: string;
  provider: string;
  service: string;
  amountCents: number;
  trackingNumber: string;
  labelUrl: string;
  carrierCode: string;
}

/**
 * The confirmed charge lands atomically: active label row, append-only audit
 * row, guarded order fulfillment, label URL, and shipped-notification outbox.
 *
 * Accepts 'uncertain' as well as 'purchasing': provider reconciliation settles
 * a parked attempt with the same fencing (its stored claim token) — which is
 * how a LATE success becomes durable instead of living only in the dashboard.
 */
export async function recordPurchased(
  db: D1Database,
  orderId: number,
  claimToken: string,
  p: PurchasedRecord,
): Promise<{ recorded: boolean; orderFulfilled: boolean }> {
  const results = await db.batch([
    // Only THIS attempt's row: a claim that was discarded and superseded finds
    // its token gone and writes nothing, anywhere.
    db
      .prepare(
        `UPDATE shipping_labels
            SET status = 'purchased', transaction_id = ?2, provider = ?3, service = ?4,
                amount_cents = ?5, tracking_number = ?6, label_url = ?7, error = NULL,
                updated_at = datetime('now')
          WHERE order_id = ?1 AND status IN ('purchasing', 'uncertain') AND claim_token = ?8`,
      )
      .bind(orderId, p.transactionId, p.provider, p.service, p.amountCents, p.trackingNumber, p.labelUrl, claimToken),
    // The active row is mutable; this append-only copy is the durable money
    // trail and survives replacement quotes and later label purchases.
    db
      .prepare(
        `INSERT OR IGNORE INTO shipping_label_attempts (
           order_id, claim_token, outcome, shipment_id, rate_id, transaction_id,
           provider, service, amount_cents, tracking_number, label_url, error,
           created_at
         )
         SELECT order_id, claim_token, 'purchased', shipment_id, rate_id,
                transaction_id, provider, service, amount_cents, tracking_number,
                label_url, error, created_at
           FROM shipping_labels
          WHERE order_id = ?1 AND status = 'purchased'
            AND claim_token = ?2 AND transaction_id = ?3`,
      )
      .bind(orderId, claimToken, p.transactionId),
    // Fulfillment repeats the FULL eligibility, not just 'unfulfilled': the
    // order may have been refunded while the provider call was in flight, and a
    // refunded order must not become fulfilled-with-tracking. It is also
    // conditional on statement 1 having recorded THIS attempt (same
    // transaction, sequential), so a superseded attempt cannot fulfil.
    db
      .prepare(
        `UPDATE orders
            SET fulfillment_status = 'fulfilled', tracking_carrier = ?2, tracking_number = ?3,
                fulfilled_at = datetime('now'), label_url = ?4
          WHERE id = ?1 AND status = 'paid' AND fulfillment_status = 'unfulfilled'
            AND delivery_method = 'shipping'
            AND EXISTS (
              SELECT 1 FROM shipping_labels
               WHERE order_id = ?1 AND status = 'purchased' AND claim_token = ?5
            )`,
      )
      .bind(orderId, p.carrierCode, p.trackingNumber, p.labelUrl, claimToken),
    // Same INSERT OR IGNORE contract as outboxStore.queueNotification, inlined so
    // it joins this batch — and conditional on the guarded transition above
    // having landed OUR tracking, so a shipped email can neither carry another
    // path's number nor go out for an order that refused fulfillment.
    db
      .prepare(
        `INSERT OR IGNORE INTO order_notifications (order_id, kind)
         SELECT ?1, 'order-shipped'
          WHERE EXISTS (
            SELECT 1 FROM orders
             WHERE id = ?1 AND fulfillment_status = 'fulfilled' AND tracking_number = ?2
          )
            AND EXISTS (
              SELECT 1 FROM shipping_labels
               WHERE order_id = ?1 AND status = 'purchased' AND claim_token = ?3
            )`,
      )
      .bind(orderId, p.trackingNumber, claimToken),
  ]);
  // Zero-row transitions are reconciliation signals, not success. `recorded`
  // false = this attempt was superseded; its label exists only at Shippo.
  return {
    recorded: (results[0]?.meta?.changes ?? 0) > 0,
    orderFulfilled: (results[2]?.meta?.changes ?? 0) > 0,
  };
}

/** Shippo said no. Safe to quote again. */
/**
 * Shippo said no — either to the live request, or to a reconciliation query
 * that proved the submitted attempt never bought anything. Only THEN does the
 * order reopen for quoting.
 */
export async function markLabelFailed(
  db: D1Database,
  orderId: number,
  claimToken: string,
  error: string,
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE shipping_labels
            SET status = 'failed', error = ?2, updated_at = datetime('now')
          WHERE order_id = ?1 AND status IN ('purchasing', 'uncertain') AND claim_token = ?3`,
      )
      .bind(orderId, error, claimToken),
    db
      .prepare(
        `INSERT OR IGNORE INTO shipping_label_attempts (
           order_id, claim_token, outcome, shipment_id, rate_id, transaction_id,
           provider, service, amount_cents, tracking_number, label_url, error,
           created_at
         )
         SELECT order_id, claim_token, 'failed', shipment_id, rate_id,
                transaction_id, provider, service, amount_cents, tracking_number,
                label_url, error, created_at
           FROM shipping_labels
          WHERE order_id = ?1 AND status = 'failed' AND claim_token = ?2
            AND error = ?3`,
      )
      .bind(orderId, claimToken, error),
  ]);
  return (results[0]?.meta?.changes ?? 0) > 0;
}

/** The outcome is unknown — park it; a human resolves it against the dashboard. */
export async function markLabelUncertain(
  db: D1Database,
  orderId: number,
  claimToken: string,
  error: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE shipping_labels
          SET status = 'uncertain', error = ?2, updated_at = datetime('now')
        WHERE order_id = ?1 AND status = 'purchasing' AND claim_token = ?3`,
    )
    .bind(orderId, error, claimToken)
    .run();
}

/**
 * Abandon a quote or a definitively-failed attempt. NOTHING ELSE: a purchase
 * that was submitted ('purchasing', however old) or answered ambiguously
 * ('uncertain') may still have moved money, and locally deleting it would let
 * a second real purchase start while the first completes — the double-charge
 * the whole machine exists to prevent. Those states are settled exclusively by
 * asking Shippo (reconciliation), which either records the late success
 * durably or proves no purchase happened and marks the row failed.
 */
export async function discardLabelAttempt(db: D1Database, orderId: number): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM shipping_labels
        WHERE order_id = ?1 AND status IN ('quoted', 'failed')`,
    )
    .bind(orderId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Shippo confirms the attempt bought a label that was then REFUNDED. Record the
 * original transaction for audit FIRST — only that recording reopens quoting
 * (status 'failed'), so the money trail survives even though no usable label
 * exists.
 */
export async function recordRefundedAttempt(
  db: D1Database,
  orderId: number,
  claimToken: string,
  p: PurchasedRecord,
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE shipping_labels
            SET status = 'failed', transaction_id = ?2, provider = ?3, service = ?4,
                amount_cents = ?5, tracking_number = ?6, label_url = ?7,
                error = 'Purchased then refunded at Shippo (transaction ' || ?2 || ').',
                updated_at = datetime('now')
          WHERE order_id = ?1 AND status IN ('purchasing', 'uncertain') AND claim_token = ?8`,
      )
      .bind(orderId, p.transactionId, p.provider, p.service, p.amountCents, p.trackingNumber, p.labelUrl, claimToken),
    db
      .prepare(
        `INSERT OR IGNORE INTO shipping_label_attempts (
           order_id, claim_token, outcome, shipment_id, rate_id, transaction_id,
           provider, service, amount_cents, tracking_number, label_url, error,
           created_at
         )
         SELECT order_id, claim_token, 'refunded', shipment_id, rate_id,
                transaction_id, provider, service, amount_cents, tracking_number,
                label_url, error, created_at
           FROM shipping_labels
          WHERE order_id = ?1 AND status = 'failed' AND claim_token = ?2
            AND transaction_id = ?3`,
      )
      .bind(orderId, claimToken, p.transactionId),
  ]);
  return (results[0]?.meta?.changes ?? 0) > 0;
}

/**
 * The MANUAL RISK-BEARING OVERRIDE for an attempt whose POST plausibly never
 * reached Shippo. Deleting a submitted attempt abandons the single-shot
 * guarantee for this order: if the lost request completes after all, its label
 * exists only at Shippo. The route puts that in the merchant's own words
 * before offering this; nothing calls it automatically.
 */
export async function forceDiscardLabelAttempt(db: D1Database, orderId: number): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO shipping_label_attempts (
           order_id, claim_token, outcome, shipment_id, rate_id, transaction_id,
           provider, service, amount_cents, tracking_number, label_url, error,
           created_at
         )
         SELECT order_id, claim_token, 'force_discarded', shipment_id, rate_id,
                transaction_id, provider, service, amount_cents, tracking_number,
                label_url, error, created_at
           FROM shipping_labels
          WHERE order_id = ?1 AND status IN ('purchasing', 'uncertain')
            AND claim_token IS NOT NULL`,
      )
      .bind(orderId),
    db
      .prepare(
        `DELETE FROM shipping_labels
          WHERE order_id = ?1 AND status IN ('purchasing', 'uncertain')`,
      )
      .bind(orderId),
  ]);
  return (results[1]?.meta?.changes ?? 0) > 0;
}
