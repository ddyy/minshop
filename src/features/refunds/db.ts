// Refund accounting.
//
// Two independent components on `orders` add up to the derived `refunded_cents`
// (see migration 0025):
//
//   provider_refunded_cents  ABSOLUTE — synchronised to the provider's own
//                            cumulative number, never incremented. This is what
//                            makes replayed and out-of-order webhooks free.
//   external_refunded_cents  ADDITIVE — money returned outside the provider, or
//                            demo bookkeeping. Only ever recorded by a human.
//
// D1 has no interactive transactions, so nothing here reads, branches in JS and
// then writes: that sequence has no isolation and two concurrent refunds would
// both see the same stale balance. Instead every mutation is a `db.batch()` of
// guarded statements — the balance check lives in the WHERE clause, and
// RETURNING tells us whether it actually applied. The same pattern the order
// settlement path uses (orders/db.ts).

import type { Order } from '../orders/db';
import { generatePublicId, isPublicIdConflict } from '../ids/publicId.ts';

/** Ledger kinds. See migration 0025 for what each one means. */

/**
 * Run a refund write batch, regenerating the rfnd_ public id on a unique
 * conflict — the id binds inside the claim INSERT, so the whole statement set
 * is rebuilt per attempt. Idempotency-key conflicts are handled in SQL
 * (ON CONFLICT DO NOTHING) and never reach this retry.
 */
async function batchWithRefundId<T>(
  db: D1Database,
  build: (publicId: string) => ReturnType<D1Database['prepare']>[],
): Promise<D1Result<T>[]> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await db.batch<T>(build(generatePublicId('refund')));
    } catch (err) {
      if (!isPublicIdConflict(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

export type RefundKind =
  | 'provider_api'
  | 'provider_sync'
  | 'manual_external'
  | 'manual_reversal'
  | 'demo'
  | 'legacy';

export type RefundStatus = 'pending' | 'succeeded' | 'failed' | 'canceled';

export interface Refund {
  id: number;
  public_id: string;
  order_id: number;
  kind: RefundKind;
  status: RefundStatus;
  /** Always a delta, never a cumulative total. Negative for manual_reversal. */
  amount_cents: number;
  provider: string | null;
  provider_refund_id: string | null;
  provider_event_id: string | null;
  reason: string | null;
  note: string | null;
  created_by: string | null;
  idempotency_key: string;
  reverses_refund_id: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Why a refund didn't apply.
 *
 * `duplicate` is deliberately distinguished from `insufficient_balance` even
 * though the guarded batch produces an identical empty result for both: the
 * merchant needs to be told "you already recorded this" rather than "that's
 * more than the remaining balance". One read after the batch tells them apart.
 */
export type RefundFailure =
  | 'duplicate'
  | 'insufficient_balance'
  | 'not_refundable'
  | 'invalid_amount';

export type RefundResult =
  | { ok: true; refund: Refund; refundedCents: number; fullyRefunded: boolean }
  | { ok: false; reason: RefundFailure; refund?: Refund };

/** Orders that can still take a refund. 'pending' means never paid. */
const REFUNDABLE_STATUSES = "('paid', 'refunded')";

/** Remaining refundable balance, in cents. */
export function refundableCents(order: Order): number {
  return Math.max(0, order.amount_total_cents - order.refunded_cents);
}

async function findByIdempotencyKey(
  db: D1Database,
  key: string,
): Promise<Refund | null> {
  return db
    .prepare('SELECT * FROM refunds WHERE idempotency_key = ?')
    .bind(key)
    .first<Refund>();
}

async function orderTotals(
  db: D1Database,
  orderId: number,
): Promise<{ refunded_cents: number; amount_total_cents: number } | null> {
  return db
    .prepare('SELECT refunded_cents, amount_total_cents FROM orders WHERE id = ?')
    .bind(orderId)
    .first();
}

export interface ExternalRefundInput {
  orderId: number;
  amountCents: number;
  /** Caller-supplied so a double-submitted form collapses to one refund. */
  idempotencyKey: string;
  kind?: Extract<RefundKind, 'manual_external' | 'demo'>;
  reason?: string | null;
  note?: string | null;
  createdBy?: string | null;
  provider?: string | null;
}

/**
 * Record money already returned to the customer outside the provider —
 * a Lightning repayment, a bank transfer, or demo bookkeeping.
 *
 * Moves no money. Increments `external_refunded_cents` additively.
 *
 * The three statements run as one batch:
 *   1. Claim a `pending` ledger row, but only while the balance covers it.
 *      ON CONFLICT DO NOTHING makes a replayed key claim nothing.
 *   2. Apply the increment, but only while that claim is still pending — so a
 *      replay (whose claim is already `succeeded`) cannot increment again.
 *   3. Consume the claim.
 *
 * Statement 2 applies exactly when statement 1 inserted: the batch is
 * serialized, so no concurrent writer can move the balance between them.
 */
export async function recordExternalRefund(
  db: D1Database,
  input: ExternalRefundInput,
): Promise<RefundResult> {
  const {
    orderId,
    amountCents,
    idempotencyKey,
    kind = 'manual_external',
    reason = null,
    note = null,
    createdBy = null,
    provider = null,
  } = input;

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, reason: 'invalid_amount' };
  }

  const buildStatements = (publicId: string) => [
    // 1. Claim.
    db
      .prepare(
        `INSERT INTO refunds (
           public_id, order_id, kind, status, amount_cents, provider,
           reason, note, created_by, idempotency_key, created_at, updated_at
         )
         SELECT ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now')
           FROM orders
          WHERE id = ?
            AND status IN ${REFUNDABLE_STATUSES}
            AND provider_refunded_cents + external_refunded_cents + ? <= amount_total_cents
         ON CONFLICT(idempotency_key) DO NOTHING
         RETURNING id`,
      )
      .bind(
        publicId,
        orderId,
        kind,
        amountCents,
        provider,
        reason,
        note,
        createdBy,
        idempotencyKey,
        orderId,
        amountCents,
      ),

    // 2. Apply. `ELSE status END` never invents a status — an order that was
    //    never paid keeps its own, rather than being silently marked 'paid'.
    db
      .prepare(
        `UPDATE orders
            SET external_refunded_cents = external_refunded_cents + ?,
                status = CASE
                  WHEN provider_refunded_cents + external_refunded_cents + ? >= amount_total_cents
                  THEN 'refunded' ELSE status END
          WHERE id = ?
            AND status IN ${REFUNDABLE_STATUSES}
            AND provider_refunded_cents + external_refunded_cents + ? <= amount_total_cents
            AND EXISTS (
              SELECT 1 FROM refunds WHERE idempotency_key = ? AND status = 'pending'
            )
         RETURNING id`,
      )
      .bind(amountCents, amountCents, orderId, amountCents, idempotencyKey),

    // 3. Consume.
    db
      .prepare(
        `UPDATE refunds SET status = 'succeeded', updated_at = datetime('now')
          WHERE idempotency_key = ? AND status = 'pending'`,
      )
      .bind(idempotencyKey),
  ];

  const results = await batchWithRefundId<{ id: number }>(db, buildStatements);
  const applied = results[1]?.results?.[0];

  if (!applied) {
    // Nothing moved. Which of the two guards rejected it?
    const existing = await findByIdempotencyKey(db, idempotencyKey);
    if (existing) return { ok: false, reason: 'duplicate', refund: existing };
    const totals = await orderTotals(db, orderId);
    return { ok: false, reason: totals ? 'insufficient_balance' : 'not_refundable' };
  }

  const refund = await findByIdempotencyKey(db, idempotencyKey);
  const totals = await orderTotals(db, orderId);
  return {
    ok: true,
    refund: refund!,
    refundedCents: totals?.refunded_cents ?? 0,
    fullyRefunded: (totals?.refunded_cents ?? 0) >= (totals?.amount_total_cents ?? 0),
  };
}

export interface ProviderSyncInput {
  orderId: number;
  /** The provider's ABSOLUTE cumulative refunded total for the charge. */
  cumulativeRefundedCents: number;
  provider: string;
  idempotencyKey: string;
  providerRefundId?: string | null;
  providerEventId?: string | null;
  reason?: string | null;
  createdBy?: string | null;
}

export type ProviderSyncResult =
  | { ok: true; advanced: false; refundedCents: number }
  | {
      ok: true;
      advanced: true;
      deltaCents: number;
      refundedCents: number;
      fullyRefunded: boolean;
      refund: Refund;
    }
  | { ok: false; reason: 'not_found' | 'no_change' };

/**
 * Synchronise the provider's own cumulative refunded total onto the order.
 *
 * Absolute, not additive: `provider_refunded_cents` becomes
 * MAX(current, incoming). A duplicate webhook, an out-of-order webhook, or a
 * manual sync of a total we already hold is therefore a harmless no-op, and a
 * minshop-initiated refund followed by its own `charge.refunded` counts once.
 *
 * The ledger records only the DELTA the total advanced by, so refund history
 * sums to the provider component rather than double-counting it.
 */
export async function syncProviderRefund(
  db: D1Database,
  input: ProviderSyncInput,
): Promise<ProviderSyncResult> {
  const {
    orderId,
    cumulativeRefundedCents,
    provider,
    idempotencyKey,
    providerRefundId = null,
    providerEventId = null,
    reason = null,
    createdBy = null,
  } = input;

  const current = await db
    .prepare(
      'SELECT provider_refunded_cents AS p, amount_total_cents AS t FROM orders WHERE id = ?',
    )
    .bind(orderId)
    .first<{ p: number; t: number }>();
  if (!current) return { ok: false, reason: 'not_found' };

  // The read above is only a fast path for the common "nothing new" webhook.
  // The authoritative check is the guarded UPDATE below, which re-evaluates
  // against the row at write time.
  const delta = cumulativeRefundedCents - current.p;
  if (delta <= 0) {
    const totals = await orderTotals(db, orderId);
    return { ok: true, advanced: false, refundedCents: totals?.refunded_cents ?? 0 };
  }

  const buildStatements = (publicId: string) => [
    db
      .prepare(
        `INSERT INTO refunds (
           public_id, order_id, kind, status, amount_cents, provider,
           provider_refund_id, provider_event_id, reason, created_by,
           idempotency_key, created_at, updated_at
         )
         SELECT ?, ?, 'provider_sync', 'pending', ? - provider_refunded_cents, ?,
                ?, ?, ?, ?, ?, datetime('now'), datetime('now')
           FROM orders
          WHERE id = ? AND provider_refunded_cents < ?
         ON CONFLICT(idempotency_key) DO NOTHING
         RETURNING id`,
      )
      .bind(
        publicId,
        orderId,
        cumulativeRefundedCents,
        provider,
        providerRefundId,
        providerEventId,
        reason,
        createdBy,
        idempotencyKey,
        orderId,
        cumulativeRefundedCents,
      ),

    db
      .prepare(
        `UPDATE orders
            SET provider_refunded_cents = MAX(provider_refunded_cents, ?),
                status = CASE
                  WHEN MAX(provider_refunded_cents, ?) + external_refunded_cents
                       >= amount_total_cents
                  THEN 'refunded' ELSE status END
          WHERE id = ?
            AND provider_refunded_cents < ?
            AND EXISTS (
              SELECT 1 FROM refunds WHERE idempotency_key = ? AND status = 'pending'
            )
         RETURNING id`,
      )
      .bind(
        cumulativeRefundedCents,
        cumulativeRefundedCents,
        orderId,
        cumulativeRefundedCents,
        idempotencyKey,
      ),

    db
      .prepare(
        `UPDATE refunds SET status = 'succeeded', updated_at = datetime('now')
          WHERE idempotency_key = ? AND status = 'pending'`,
      )
      .bind(idempotencyKey),
  ];

  const results = await batchWithRefundId<{ id: number }>(db, buildStatements);
  const applied = results[1]?.results?.[0];

  if (!applied) {
    const totals = await orderTotals(db, orderId);
    return { ok: true, advanced: false, refundedCents: totals?.refunded_cents ?? 0 };
  }

  const refund = await findByIdempotencyKey(db, idempotencyKey);
  const totals = await orderTotals(db, orderId);
  return {
    ok: true,
    advanced: true,
    deltaCents: refund?.amount_cents ?? delta,
    refundedCents: totals?.refunded_cents ?? 0,
    fullyRefunded: (totals?.refunded_cents ?? 0) >= (totals?.amount_total_cents ?? 0),
    refund: refund!,
  };
}

/**
 * Correct a mistaken manual or demo entry. Moves no money — it only undoes
 * minshop bookkeeping, so it is refused for provider-authoritative rows whose
 * numbers belong to Stripe rather than to us.
 *
 * `reverses_refund_id` is UNIQUE, so the same entry can never be voided twice:
 * the second attempt loses the claim insert and the batch applies nothing.
 */
export async function voidRecordedRefund(
  db: D1Database,
  input: {
    refundId: number;
    idempotencyKey: string;
    reason?: string | null;
    createdBy?: string | null;
  },
): Promise<RefundResult> {
  const { refundId, idempotencyKey, reason = null, createdBy = null } = input;

  const target = await db
    .prepare('SELECT * FROM refunds WHERE id = ?')
    .bind(refundId)
    .first<Refund>();
  if (!target) return { ok: false, reason: 'not_refundable' };
  if (target.status !== 'succeeded') return { ok: false, reason: 'not_refundable' };
  if (target.kind !== 'manual_external' && target.kind !== 'demo') {
    return { ok: false, reason: 'not_refundable' };
  }

  const buildStatements = (publicId: string) => [
    db
      .prepare(
        `INSERT INTO refunds (
           public_id, order_id, kind, status, amount_cents, provider,
           reason, created_by, idempotency_key, reverses_refund_id,
           created_at, updated_at
         )
         SELECT ?, ?, 'manual_reversal', 'pending', -amount_cents, provider,
                ?, ?, ?, id, datetime('now'), datetime('now')
           FROM refunds
          WHERE id = ?
            AND status = 'succeeded'
            AND kind IN ('manual_external', 'demo')
            AND NOT EXISTS (SELECT 1 FROM refunds r2 WHERE r2.reverses_refund_id = refunds.id)
         ON CONFLICT(idempotency_key) DO NOTHING
         RETURNING id`,
      )
      .bind(publicId, target.order_id, reason, createdBy, idempotencyKey, refundId),

    // Never drops below zero, and re-derives full/partial from the new total:
    // a corrected order stops being 'refunded' if it no longer is.
    db
      .prepare(
        `UPDATE orders
            SET external_refunded_cents = MAX(0, external_refunded_cents - ?),
                status = CASE
                  WHEN provider_refunded_cents + MAX(0, external_refunded_cents - ?)
                       >= amount_total_cents
                  THEN 'refunded'
                  WHEN status = 'refunded' THEN 'paid'
                  ELSE status END
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM refunds WHERE idempotency_key = ? AND status = 'pending'
            )
         RETURNING id`,
      )
      .bind(target.amount_cents, target.amount_cents, target.order_id, idempotencyKey),

    db
      .prepare(
        `UPDATE refunds SET status = 'succeeded', updated_at = datetime('now')
          WHERE idempotency_key = ? AND status = 'pending'`,
      )
      .bind(idempotencyKey),
  ];
  // The reversed row keeps its 'succeeded' status: it did happen, and the
  // reversal row's `reverses_refund_id` is what marks it undone. Cancelling it
  // as well would double-count the undo — the ledger would carry both a missing
  // +X and a present -X, so summing succeeded rows would no longer equal
  // external_refunded_cents. `isReversed()` is how the UI renders it instead.

  const results = await batchWithRefundId<{ id: number }>(db, buildStatements);
  const applied = results[1]?.results?.[0];

  if (!applied) {
    const existing = await findByIdempotencyKey(db, idempotencyKey);
    if (existing) return { ok: false, reason: 'duplicate', refund: existing };
    return { ok: false, reason: 'not_refundable' };
  }

  const refund = await findByIdempotencyKey(db, idempotencyKey);
  const totals = await orderTotals(db, target.order_id);
  return {
    ok: true,
    refund: refund!,
    refundedCents: totals?.refunded_cents ?? 0,
    fullyRefunded: (totals?.refunded_cents ?? 0) >= (totals?.amount_total_cents ?? 0),
  };
}

/**
 * Which refunds in a history have been voided. A reversed entry keeps its
 * 'succeeded' status so the ledger still sums correctly (see voidRecordedRefund),
 * so "was this undone?" is answered by the presence of a reversal pointing at it.
 */
export function reversedRefundIds(history: Refund[]): Set<number> {
  return new Set(
    history
      .filter((r) => r.kind === 'manual_reversal' && r.reverses_refund_id !== null)
      .map((r) => r.reverses_refund_id as number),
  );
}

/** Refund by its public ID — rfnd_ or a preserved legacy UUID (boundary resolution). */
export async function getRefundByPublicId(
  db: D1Database,
  publicId: string,
): Promise<Refund | null> {
  return db.prepare('SELECT * FROM refunds WHERE public_id = ?').bind(publicId).first<Refund>();
}

/** Refund history for an order, newest first. */
export async function listRefunds(db: D1Database, orderId: number): Promise<Refund[]> {
  const { results } = await db
    .prepare('SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at DESC, id DESC')
    .bind(orderId)
    .all<Refund>();
  return results ?? [];
}

/**
 * Flag an order for reconciliation. A new conflict clears a previous
 * acknowledgement, so an acknowledged-then-broken-again order reopens rather
 * than staying quietly resolved.
 */
export async function openRefundReview(
  db: D1Database,
  orderId: number,
  reason: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE orders
          SET refund_review_reason = ?, refund_reviewed_at = NULL, refund_reviewed_by = NULL
        WHERE id = ?`,
    )
    .bind(reason, orderId)
    .run();
}

/**
 * Open a reconciliation review when the two components together exceed the
 * order total — the provider's own number and a hand-recorded one are each
 * plausible, so neither is discarded and a human decides which is wrong.
 *
 * Reads current state rather than taking a caller's snapshot, so every path
 * that can move a total (webhook, admin sync, manual record) gets the same
 * answer. The generated aggregate is already clamped; this is what makes the
 * conflict visible instead of silently absorbed.
 *
 * Returns the review reason when one was opened, otherwise null.
 */
export async function openReviewIfOverRefunded(
  db: D1Database,
  orderId: number,
): Promise<string | null> {
  const over = await db
    .prepare(
      `SELECT id FROM orders
        WHERE id = ?
          AND provider_refunded_cents + external_refunded_cents > amount_total_cents`,
    )
    .bind(orderId)
    .first<{ id: number }>();
  if (!over) return null;
  const reason = 'exceeds_order_total';
  await openRefundReview(db, orderId, reason);
  return reason;
}

export async function acknowledgeRefundReview(
  db: D1Database,
  orderId: number,
  reviewedBy: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE orders
          SET refund_reviewed_at = datetime('now'), refund_reviewed_by = ?
        WHERE id = ? AND refund_review_reason IS NOT NULL`,
    )
    .bind(reviewedBy, orderId)
    .run();
}

export interface RefundSyncEvent {
  provider_event_id: string;
  provider: string;
  provider_payment_id: string | null;
  provider_charge_id: string | null;
  cumulative_refunded_cents: number;
  currency: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  processed_at: string | null;
  /** Joined: the order claiming this payment, when one does. */
  order_id?: number | null;
}

/**
 * Refund events a provider sent that no order claims yet — almost always an
 * order settled before its payment id was stored. They are money that really
 * moved, so they are surfaced for reconciliation rather than dropped.
 */
export async function listUnmatchedRefundEvents(
  db: D1Database,
  limit = 20,
): Promise<RefundSyncEvent[]> {
  // The join separates the two very different cases sharing this queue:
  // `unmatched` (no order claims the payment — Retry can still correlate it)
  // from `failed` (the order was found but the event contradicts it, e.g. a
  // currency mismatch — retrying just reproduces it, so it needs a human).
  const { results } = await db
    .prepare(
      `SELECT e.*, o.id AS order_id
         FROM refund_sync_events e
         LEFT JOIN orders o ON o.provider_payment_id = e.provider_payment_id
        WHERE e.status IN ('unmatched', 'failed')
        ORDER BY e.created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<RefundSyncEvent>();
  return results ?? [];
}

/**
 * Close out a CONFLICTING refund event a human has resolved out of band.
 *
 * Restricted to `failed` on purpose. A `failed` event was matched to an order
 * and contradicts it (a currency mismatch, say): there is nothing left to
 * re-apply, so it needs a terminal state or the queue never empties and starts
 * being ignored. An `unmatched` event is the opposite — a refund that really
 * happened and has NO order yet — and dismissing one would permanently hide
 * real money from reconciliation. Those are only ever resolved by correlating
 * them, so the guard lives here rather than in the UI that happens to offer the
 * right button today.
 *
 * The original failure reason is kept and the dismissal appended, so the audit
 * record still says what the conflict actually was.
 */
export async function dismissRefundEvent(
  db: D1Database,
  eventId: string,
  dismissedBy: string | null,
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE refund_sync_events
          SET status = 'dismissed',
              processed_at = datetime('now'),
              last_error = COALESCE(last_error, 'conflict') || ?
        WHERE provider_event_id = ? AND status = 'failed'
        RETURNING provider_event_id`,
    )
    .bind(dismissedBy ? ` — dismissed by ${dismissedBy}` : ' — dismissed', eventId)
    .first();
  return !!row;
}

/** Orders flagged for refund reconciliation and not yet acknowledged. */
export async function countOpenRefundReviews(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM orders
        WHERE refund_review_reason IS NOT NULL AND refund_reviewed_at IS NULL`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}
