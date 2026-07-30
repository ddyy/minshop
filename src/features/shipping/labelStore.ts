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
 *   retries it automatically; only an explicit discard reopens the order.
 */

import type { D1Database } from '@cloudflare/workers-types';

export type LabelStatus = 'quoted' | 'purchasing' | 'purchased' | 'failed' | 'uncertain';

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
}

/** The order must still be worth labelling: paid, unfulfilled, not a pickup. */
const ORDER_ELIGIBLE = `EXISTS (
  SELECT 1 FROM orders
   WHERE id = ?1 AND status = 'paid' AND fulfillment_status = 'unfulfilled'
     AND COALESCE(delivery_method, 'shipping') = 'shipping'
)`;

export async function getLabelRecord(db: D1Database, orderId: number): Promise<LabelRecord | null> {
  return db
    .prepare('SELECT * FROM shipping_labels WHERE order_id = ?')
    .bind(orderId)
    .first<LabelRecord>();
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
): Promise<{ shipmentId: string } | null> {
  const row = await db
    .prepare(
      `UPDATE shipping_labels
          SET status = 'purchasing', rate_id = ?2, updated_at = datetime('now')
        WHERE order_id = ?1 AND status = 'quoted' AND ${ORDER_ELIGIBLE}
        RETURNING shipment_id`,
    )
    .bind(orderId, rateId)
    .first<{ shipment_id: string }>();
  return row ? { shipmentId: row.shipment_id } : null;
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
 * The confirmed charge lands atomically: label row, order fulfillment (guarded —
 * a concurrent manual fulfil cannot be overwritten), the label URL, and the
 * shipped-notification outbox row all commit in one batch, so a crash after the
 * charge can no longer leave a paid label unrecorded.
 */
export async function recordPurchased(
  db: D1Database,
  orderId: number,
  p: PurchasedRecord,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE shipping_labels
            SET status = 'purchased', transaction_id = ?2, provider = ?3, service = ?4,
                amount_cents = ?5, tracking_number = ?6, label_url = ?7, error = NULL,
                updated_at = datetime('now')
          WHERE order_id = ?1 AND status = 'purchasing'`,
      )
      .bind(orderId, p.transactionId, p.provider, p.service, p.amountCents, p.trackingNumber, p.labelUrl),
    db
      .prepare(
        `UPDATE orders
            SET fulfillment_status = 'fulfilled', tracking_carrier = ?2, tracking_number = ?3,
                fulfilled_at = datetime('now'), label_url = ?4
          WHERE id = ?1 AND fulfillment_status = 'unfulfilled'`,
      )
      .bind(orderId, p.carrierCode, p.trackingNumber, p.labelUrl),
    // Same INSERT OR IGNORE contract as outboxStore.queueNotification, inlined
    // so it joins this batch: the shipped email survives a crash right here.
    db
      .prepare(`INSERT OR IGNORE INTO order_notifications (order_id, kind) VALUES (?1, 'order-shipped')`)
      .bind(orderId),
  ]);
}

/** Shippo said no. Safe to quote again. */
export async function markLabelFailed(db: D1Database, orderId: number, error: string): Promise<void> {
  await db
    .prepare(
      `UPDATE shipping_labels
          SET status = 'failed', error = ?2, updated_at = datetime('now')
        WHERE order_id = ?1 AND status = 'purchasing'`,
    )
    .bind(orderId, error)
    .run();
}

/** The outcome is unknown — park it; a human resolves it against the dashboard. */
export async function markLabelUncertain(db: D1Database, orderId: number, error: string): Promise<void> {
  await db
    .prepare(
      `UPDATE shipping_labels
          SET status = 'uncertain', error = ?2, updated_at = datetime('now')
        WHERE order_id = ?1 AND status = 'purchasing'`,
    )
    .bind(orderId, error)
    .run();
}

/**
 * The merchant's explicit "I checked the dashboard, no label exists" (or
 * abandoning a quote). Deliberately cannot touch a purchased row.
 */
export async function discardLabelAttempt(db: D1Database, orderId: number): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM shipping_labels
        WHERE order_id = ? AND status IN ('quoted', 'failed', 'uncertain', 'purchasing')`,
    )
    .bind(orderId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
