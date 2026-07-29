import type { D1Database } from '@cloudflare/workers-types';

/**
 * The order_notifications state machine — every statement that moves a row
 * between states, and nothing else. Split from outbox.ts (which owns message
 * building and sending) so this half has NO `cloudflare:workers` dependency:
 * test/integration/reservations.mjs runs these exact statements against a real
 * miniflare D1, where a unit-test fake would let malformed SQL or bind
 * ordering pass unnoticed.
 */

export const NOTIFICATION_KINDS = ['customer-receipt', 'owner-notification'] as const;

/**
 * Versioned-kind family for guest-link reissue (see the public-ID plan): each
 * reissue queues `guest-link-reissue:<generation>` so a repeat reissue gets its
 * own row and idempotency key instead of colliding with the first. The
 * deliverer recognises the prefix rather than a fixed string, and skips any
 * event whose generation no longer matches order_guest_access.generation.
 */
export const GUEST_LINK_REISSUE_PREFIX = 'guest-link-reissue:';
export type GuestLinkReissueKind = `${typeof GUEST_LINK_REISSUE_PREFIX}${number}`;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number] | GuestLinkReissueKind;

export function isGuestLinkReissueKind(kind: string): kind is GuestLinkReissueKind {
  return kind.startsWith(GUEST_LINK_REISSUE_PREFIX) && reissueGeneration(kind) !== null;
}

/** The <generation> a reissue kind carries, or null for a malformed kind. */
export function reissueGeneration(kind: string): number | null {
  if (!kind.startsWith(GUEST_LINK_REISSUE_PREFIX)) return null;
  const raw = kind.slice(GUEST_LINK_REISSUE_PREFIX.length);
  const n = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function guestLinkReissueKind(generation: number): GuestLinkReissueKind {
  return `${GUEST_LINK_REISSUE_PREFIX}${generation}`;
}

/**
 * Queue one notification row outside the settlement batch (reissue). INSERT OR
 * IGNORE: the (order_id, kind) PK makes a repeat of the SAME versioned kind a
 * no-op, which is exactly the idempotency the versioned kind exists to scope.
 */
export async function queueNotification(
  db: D1Database,
  orderId: number,
  kind: NotificationKind,
): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO order_notifications (order_id, kind) VALUES (?, ?)')
    .bind(orderId, kind)
    .run();
}

/**
 * Every kind an order could still deliver: pending, or processing with an
 * expired lease. The deliverer iterates THIS rather than the fixed kind list so
 * versioned reissue rows are picked up by the same claim/send/mark machinery.
 */
export async function listUndeliveredKinds(
  db: D1Database,
  orderId: number,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT kind FROM order_notifications
        WHERE order_id = ?
          AND (state = 'pending'
               OR (state = 'processing' AND lease_expires_at < datetime('now')))
        ORDER BY created_at, kind`,
    )
    .bind(orderId)
    .all<{ kind: string }>();
  return (results ?? []).map((r) => r.kind);
}

/** Attempts after which a row is abandoned as 'dead' (last_error says why). */
export const MAX_ATTEMPTS = 5;
/** Claim lease. A deliverer that dies mid-send frees its row this much later. */
export const LEASE_SECONDS = 120;

/**
 * Claim one row: pending, or processing with an expired lease (a dead
 * deliverer's abandoned claim). Exactly one concurrent caller wins. Returns
 * the attempt number, or null when there is nothing to claim (row absent,
 * already sent/skipped/dead, or validly leased by someone else).
 */
export async function claimNotification(
  db: D1Database,
  orderId: number,
  kind: NotificationKind,
): Promise<number | null> {
  // An abandoned claim (deliverer cancelled mid-send — waitUntil is bounded to
  // ~30s after the response) consumed its attempt at claim time. Once the
  // attempts are spent, park the row instead of reclaiming it forever: HTTP
  // cancellation is exactly the failure mode this table exists to bound.
  await db
    .prepare(
      `UPDATE order_notifications
          SET state = 'dead', lease_expires_at = NULL,
              last_error = COALESCE(last_error, 'delivery repeatedly interrupted (lease expired)')
        WHERE order_id = ? AND kind = ? AND state = 'processing'
          AND lease_expires_at < datetime('now') AND attempts >= ${MAX_ATTEMPTS}`,
    )
    .bind(orderId, kind)
    .run();
  const row = await db
    .prepare(
      `UPDATE order_notifications
          SET state = 'processing',
              attempts = attempts + 1,
              lease_expires_at = datetime('now', '+${LEASE_SECONDS} seconds')
        WHERE order_id = ? AND kind = ? AND attempts < ${MAX_ATTEMPTS}
          AND (state = 'pending'
               OR (state = 'processing' AND lease_expires_at < datetime('now')))
        RETURNING attempts`,
    )
    .bind(orderId, kind)
    .first<{ attempts: number }>();
  return row?.attempts ?? null;
}

// Every completion update carries the claim's attempt number as a FENCING
// token (`AND attempts = ?`): if worker A's lease expired and worker B
// reclaimed the row (incrementing attempts), a late-resuming A no longer
// matches and cannot clear B's live lease or mark B's work terminal.

export async function markNotificationSent(
  db: D1Database,
  orderId: number,
  kind: NotificationKind,
  attempts: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE order_notifications
          SET state = 'sent', sent_at = datetime('now'), lease_expires_at = NULL, last_error = NULL
        WHERE order_id = ? AND kind = ? AND state = 'processing' AND attempts = ?`,
    )
    .bind(orderId, kind, attempts)
    .run();
}

export async function markNotificationSkipped(
  db: D1Database,
  orderId: number,
  kind: NotificationKind,
  attempts: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE order_notifications
          SET state = 'skipped', lease_expires_at = NULL
        WHERE order_id = ? AND kind = ? AND state = 'processing' AND attempts = ?`,
    )
    .bind(orderId, kind, attempts)
    .run();
}

/**
 * Failure: release for retry, or park as 'dead' once attempts are exhausted
 * (or immediately, for conditions no retry can cure — `terminal`). `attempts`
 * is always the claim's own number: it is the fencing token, never a way to
 * force a state.
 */
export async function markNotificationFailed(
  db: D1Database,
  orderId: number,
  kind: NotificationKind,
  attempts: number,
  error: unknown,
  terminal = false,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .prepare(
      `UPDATE order_notifications
          SET state = ?, lease_expires_at = NULL, last_error = ?
        WHERE order_id = ? AND kind = ? AND state = 'processing' AND attempts = ?`,
    )
    .bind(
      terminal || attempts >= MAX_ATTEMPTS ? 'dead' : 'pending',
      message.slice(0, 500),
      orderId,
      kind,
      attempts,
    )
    .run();
}
