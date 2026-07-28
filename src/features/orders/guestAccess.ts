import type { D1Database } from '@cloudflare/workers-types';
import { generateAccessToken, isAccessToken } from '../ids/token.ts';
import { generatePublicId, isPublicIdConflict } from '../ids/publicId.ts';
import { guestLinkReissueKind } from '../email/outboxStore.ts';

/**
 * Guest-access registry (order_guest_access) — the ONE authoritative mapping
 * from a revocable access token to an order public ID. Created at checkout
 * before provider handoff; carried through settlement; the credential behind
 * /order/<token> and /pay/<token>.
 *
 * The raw token is stored by design (not hashed): asynchronous rails settle in
 * a webhook that has only the order public ID, and later receipt/shipping/
 * refund customer emails must regenerate the guest URL. Only customer-email
 * builders may read it — never admin, MCP, or API payloads.
 */
export interface GuestAccess {
  order_public_id: string;
  access_token: string;
  generation: number;
  created_at: string;
  rotated_at: string | null;
}

/**
 * Claim a checkout's whole identity at once: a fresh ord_ public ID plus its
 * guest access token, inserted as the registry row. BOTH values regenerate on
 * a unique conflict — the registry PK is the order public id, so retrying only
 * the token could never resolve an order-id collision.
 */
export async function claimOrderIdentity(
  db: D1Database,
): Promise<{ publicId: string; accessToken: string }> {
  for (let i = 0; i < 3; i++) {
    const publicId = generatePublicId('order');
    const accessToken = generateAccessToken();
    try {
      await db
        .prepare('INSERT INTO order_guest_access (order_public_id, access_token) VALUES (?, ?)')
        .bind(publicId, accessToken)
        .run();
      return { publicId, accessToken };
    } catch (err) {
      if (!isPublicIdConflict(err)) throw err; // either side collided → fresh pair
    }
  }
  throw new Error('order identity collision retry exhausted');
}

/** Resolve a presented token to its mapping. Strict shape check first. */
export async function resolveAccessToken(
  db: D1Database,
  token: unknown,
): Promise<GuestAccess | null> {
  if (!isAccessToken(token)) return null;
  return db
    .prepare('SELECT * FROM order_guest_access WHERE access_token = ?')
    .bind(token)
    .first<GuestAccess>();
}

export async function getGuestAccess(
  db: D1Database,
  orderPublicId: string,
): Promise<GuestAccess | null> {
  return db
    .prepare('SELECT * FROM order_guest_access WHERE order_public_id = ?')
    .bind(orderPublicId)
    .first<GuestAccess>();
}

/**
 * Rotate the token for a SETTLED order (support remedy for a leaked link) AND
 * queue its guest-link-reissue:<generation> notification in the SAME D1 batch —
 * a crash between the two would otherwise kill every old link with no
 * replacement email ever queued. The settled guard is the orders join: a
 * pending checkout's hosted provider still holds the old token in its
 * success_url, so reissue there would strand a paying customer — those are
 * cancelled and recreated instead. Returns the new generation (never the
 * token — the queued email is the only delivery path), or null when the order
 * is unsettled or unknown.
 */
export async function reissueGuestAccess(
  db: D1Database,
  orderPublicId: string,
): Promise<{ generation: number } | null> {
  for (let i = 0; i < 3; i++) {
    const current = await db
      .prepare(
        `SELECT g.generation, o.id AS order_id
           FROM order_guest_access g
           JOIN orders o ON o.public_id = g.order_public_id
          WHERE g.order_public_id = ?`,
      )
      .bind(orderPublicId)
      .first<{ generation: number; order_id: number }>();
    if (!current) return null;
    const next = current.generation + 1;
    const token = generateAccessToken();
    try {
      // Atomic pair: the optimistic generation guard makes a concurrent
      // reissue lose cleanly, and the INSERT only lands when the UPDATE did.
      const results = await db.batch([
        db
          .prepare(
            `UPDATE order_guest_access
                SET access_token = ?1, generation = ?2, rotated_at = datetime('now')
              WHERE order_public_id = ?3 AND generation = ?4`,
          )
          .bind(token, next, orderPublicId, current.generation),
        db
          .prepare(
            `INSERT OR IGNORE INTO order_notifications (order_id, kind)
             SELECT ?1, ?2
              WHERE EXISTS (SELECT 1 FROM order_guest_access
                             WHERE order_public_id = ?3 AND generation = ?4)`,
          )
          .bind(current.order_id, guestLinkReissueKind(next), orderPublicId, next),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) continue; // lost a race — re-read
      return { generation: next };
    } catch (err) {
      if (!isPublicIdConflict(err)) throw err;
    }
  }
  throw new Error('guest access token collision retry exhausted');
}

/**
 * Tokenized guest order URL for CUSTOMER-facing emails and redirects — the only
 * code allowed to read the stored token. Legacy orders link by their preserved
 * public id; a new order with no registry row returns null (omit the link)
 * rather than ever emitting a bare ord_ URL. Owner/operator notifications must
 * use the authenticated /admin/orders/<public_id> route instead, never this.
 */
export async function guestOrderUrl(
  db: D1Database,
  orderPublicId: string | null,
  baseUrl: string,
): Promise<string | null> {
  if (!orderPublicId) return null;
  if (!orderPublicId.startsWith('ord_')) return `${baseUrl}/order/${orderPublicId}`;
  const access = await getGuestAccess(db, orderPublicId);
  return access ? `${baseUrl}/order/${access.access_token}` : null;
}

/**
 * Bounded reconciliation sweep for orphaned guest credentials. The inline
 * deletions (provider-expiry webhook, failed provider setup) cover the common
 * paths; this catches what they can't: demo checkouts (no webhook exists) and
 * lightning invoices whose expiry never produced a callback. Two clauses, both
 * guarded on no settled order existing, both well past any webhook retry
 * window:
 *   - a self-rendered pending payment expired > 3 days ago (its invoice/window
 *     is terminally unpayable — that IS the provider truth for these rails);
 *   - a registry row > 7 days old with no order, no live reservation, and no
 *     live pending payment (provider setup died mid-checkout).
 * LIMIT keeps it piggyback-sized; it rides along on settlements like the
 * notification sweep.
 */
export async function sweepAbandonedGuestAccess(db: D1Database, limit = 5): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM order_guest_access
        WHERE order_public_id IN (
          SELECT g.order_public_id FROM order_guest_access g
           WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.public_id = g.order_public_id)
             AND (
               EXISTS (SELECT 1 FROM pending_payments p
                        WHERE p.public_id = g.order_public_id
                          AND p.status != 'settled'
                          AND p.expires_at IS NOT NULL
                          AND p.expires_at < datetime('now', '-3 days'))
               OR (
                 g.created_at < datetime('now', '-7 days')
                 AND NOT EXISTS (SELECT 1 FROM checkout_reservations r
                                  WHERE r.public_id = g.order_public_id
                                    AND r.status IN ('active', 'payment_pending'))
                 AND NOT EXISTS (SELECT 1 FROM pending_payments p
                                  WHERE p.public_id = g.order_public_id
                                    AND p.status = 'pending'
                                    AND (p.expires_at IS NULL OR p.expires_at >= datetime('now', '-3 days')))
               )
             )
           LIMIT ?1)`,
    )
    .bind(limit)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * Garbage-collect the mapping for a checkout that reached provider-confirmed
 * terminal state without settling. The no-settled-order check is atomic with
 * the delete, so a paid webhook that raced local expiry keeps its row.
 */
export async function deleteGuestAccessIfUnsettled(
  db: D1Database,
  orderPublicId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM order_guest_access
        WHERE order_public_id = ?1
          AND NOT EXISTS (SELECT 1 FROM orders WHERE public_id = ?1)`,
    )
    .bind(orderPublicId)
    .run();
  return result.meta.changes > 0;
}
