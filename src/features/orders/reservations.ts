import type { D1Database } from '@cloudflare/workers-types';
import type { OrderItemInput } from './db';

export interface ReservationItem extends OrderItemInput {
  productId: number;
}

interface ReservationRow {
  public_id: string;
  items: string;
  status: 'active' | 'payment_pending' | 'settled' | 'released';
  expires_at: string;
}

interface StockTarget {
  productId: number;
  variantId: number | null;
  quantity: number;
}

/** Combine lines that share the same finite stock target (for example extras). */
export function aggregateStockTargets(items: ReservationItem[]): StockTarget[] {
  const targets = new Map<string, StockTarget>();
  for (const item of items) {
    const variantId = item.variantId ?? null;
    const key = variantId == null ? `p:${item.productId}` : `v:${variantId}`;
    const current = targets.get(key);
    if (current) current.quantity += item.quantity;
    else targets.set(key, { productId: item.productId, variantId, quantity: item.quantity });
  }
  return [...targets.values()];
}

function parseItems(value: string): ReservationItem[] | null {
  try {
    const items = JSON.parse(value) as ReservationItem[];
    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      items.some(
        (item) =>
          !Number.isInteger(item.productId) ||
          item.productId < 1 ||
          !Number.isInteger(item.quantity) ||
          item.quantity < 1 ||
          !Number.isInteger(item.priceCents) ||
          item.priceCents < 0 ||
          (item.variantId != null && (!Number.isInteger(item.variantId) || item.variantId < 1)) ||
          typeof item.name !== 'string',
      )
    ) {
      return null;
    }
    return items;
  } catch {
    return null;
  }
}

async function getReservation(db: D1Database, publicId: string): Promise<ReservationRow | null> {
  return db
    .prepare('SELECT public_id, items, status, expires_at FROM checkout_reservations WHERE public_id = ?')
    .bind(publicId)
    .first<ReservationRow>();
}

/** Release one still-active reservation and put its inventory back exactly once. */
export async function releaseInventoryReservation(
  db: D1Database,
  publicId: string,
): Promise<boolean> {
  const row = await getReservation(db, publicId);
  if (!row || (row.status !== 'active' && row.status !== 'payment_pending')) return false;
  const items = parseItems(row.items);
  if (!items) throw new Error(`Reservation ${publicId} has an invalid item snapshot.`);

  const releasableGuard =
    "EXISTS (SELECT 1 FROM checkout_reservations WHERE public_id = ? AND status IN ('active', 'payment_pending'))";
  const statements = aggregateStockTargets(items).map((target) =>
    target.variantId == null
      ? db
          .prepare(`UPDATE products SET stock = stock + ? WHERE id = ? AND ${releasableGuard}`)
          .bind(target.quantity, target.productId, publicId)
      : db
          .prepare(`UPDATE product_variants SET stock = stock + ? WHERE id = ? AND ${releasableGuard}`)
          .bind(target.quantity, target.variantId, publicId),
  );
  statements.push(
    db
      .prepare(
        "UPDATE checkout_reservations SET status = 'released' WHERE public_id = ? AND status IN ('active', 'payment_pending') RETURNING public_id",
      )
      .bind(publicId),
  );
  const results = await db.batch<{ public_id: string }>(statements);
  return Boolean(results.at(-1)?.results[0]);
}

/**
 * Reclaim expired self-rendered Lightning invoices before a new hold. Hosted
 * methods release only from verified provider expiry/failure webhooks: a payment
 * may have completed before local expiry while its webhook delivery is delayed.
 */
export async function releaseExpiredReservations(db: D1Database, limit = 50): Promise<void> {
  const { results } = await db
    .prepare(
      "SELECT public_id FROM checkout_reservations WHERE payment_method = 'lightning' AND status = 'active' AND expires_at <= datetime('now') ORDER BY expires_at LIMIT ?",
    )
    .bind(limit)
    .all<{ public_id: string }>();
  for (const row of results ?? []) await releaseInventoryReservation(db, row.public_id);
}

/**
 * Atomically claim all requested stock. The reservation row is inserted only if
 * every aggregated stock target is available; decrements are conditional on that
 * row, so a failed multi-line reservation cannot partially consume inventory.
 */
export async function reserveInventory(
  db: D1Database,
  publicId: string,
  items: ReservationItem[],
  ttlSeconds: number,
  paymentMethod: 'stripe' | 'opennode' | 'lightning',
): Promise<boolean> {
  if (items.length === 0 || !Number.isInteger(ttlSeconds) || ttlSeconds < 60) return false;
  await releaseExpiredReservations(db);

  const targets = aggregateStockTargets(items);
  const checks: string[] = [];
  const checkValues: number[] = [];
  for (const target of targets) {
    if (target.variantId == null) {
      checks.push('COALESCE((SELECT stock FROM products WHERE id = ? AND active = 1), -1) >= ?');
      checkValues.push(target.productId, target.quantity);
    } else {
      checks.push('COALESCE((SELECT stock FROM product_variants WHERE id = ? AND active = 1), -1) >= ?');
      checkValues.push(target.variantId, target.quantity);
    }
  }

  const insert = db
    .prepare(
      `INSERT INTO checkout_reservations (public_id, items, payment_method, expires_at)
       SELECT ?, ?, ?, datetime('now', ?)
        WHERE ${checks.join(' AND ')}
       ON CONFLICT(public_id) DO NOTHING
       RETURNING public_id`,
    )
    .bind(publicId, JSON.stringify(items), paymentMethod, `+${ttlSeconds} seconds`, ...checkValues);

  const activeGuard =
    "EXISTS (SELECT 1 FROM checkout_reservations WHERE public_id = ? AND status = 'active')";
  const decrements = targets.map((target) =>
    target.variantId == null
      ? db
          .prepare(`UPDATE products SET stock = stock - ? WHERE id = ? AND ${activeGuard}`)
          .bind(target.quantity, target.productId, publicId)
      : db
          .prepare(`UPDATE product_variants SET stock = stock - ? WHERE id = ? AND ${activeGuard}`)
          .bind(target.quantity, target.variantId, publicId),
  );
  const results = await db.batch<{ public_id: string }>([insert, ...decrements]);
  return Boolean(results[0]?.results[0]);
}

/** Load the server-side item snapshot for settlement; null means not reservable. */
export async function getActiveReservationItems(
  db: D1Database,
  publicId: string,
): Promise<ReservationItem[] | null> {
  const row = await getReservation(db, publicId);
  return row && (row.status === 'active' || row.status === 'payment_pending')
    ? parseItems(row.items)
    : null;
}

/** Protect a delayed payment from ordinary hosted-session expiry reclamation. */
export async function markInventoryReservationPaymentPending(
  db: D1Database,
  publicId: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE checkout_reservations SET status = 'payment_pending' WHERE public_id = ? AND status = 'active'",
    )
    .bind(publicId)
    .run();
}
