import type { D1Database } from '@cloudflare/workers-types';
import {
  visibleStockChanged,
  type StockTransitionPurger,
} from '../products/stock.ts';
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

interface StockUpdateRow {
  stock: number;
}

interface ProductPublicIdRow {
  id: number;
  public_id: string | null;
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

async function publicIdsForProducts(
  db: D1Database,
  productIds: Iterable<number>,
): Promise<string[]> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT id, public_id FROM products WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<ProductPublicIdRow>();
  return (results ?? [])
    .map((row) => row.public_id)
    .filter((publicId): publicId is string => typeof publicId === 'string');
}

async function purgeTransitions(
  db: D1Database,
  productIds: Iterable<number>,
  purger?: StockTransitionPurger,
): Promise<void> {
  if (!purger) return;
  const publicIds = await publicIdsForProducts(db, productIds);
  if (publicIds.length > 0) await purger(publicIds);
}

async function releaseReservation(
  db: D1Database,
  publicId: string,
): Promise<{ released: boolean; changedProductIds: number[] }> {
  const row = await getReservation(db, publicId);
  if (!row || (row.status !== 'active' && row.status !== 'payment_pending')) {
    return { released: false, changedProductIds: [] };
  }
  const items = parseItems(row.items);
  if (!items) throw new Error(`Reservation ${publicId} has an invalid item snapshot.`);

  const targets = aggregateStockTargets(items);
  const releasableGuard =
    "EXISTS (SELECT 1 FROM checkout_reservations WHERE public_id = ? AND status IN ('active', 'payment_pending'))";
  const statements = targets.map((target) =>
    target.variantId == null
      ? db
          .prepare(
            `UPDATE products SET stock = stock + ? WHERE id = ? AND ${releasableGuard} RETURNING stock`,
          )
          .bind(target.quantity, target.productId, publicId)
      : db
          .prepare(
            `UPDATE product_variants SET stock = stock + ? WHERE id = ? AND ${releasableGuard} RETURNING stock`,
          )
          .bind(target.quantity, target.variantId, publicId),
  );
  statements.push(
    db
      .prepare(
        "UPDATE checkout_reservations SET status = 'released' WHERE public_id = ? AND status IN ('active', 'payment_pending') RETURNING public_id",
      )
      .bind(publicId),
  );
  const results = await db.batch<StockUpdateRow & { public_id?: string }>(statements);
  const released = Boolean(results.at(-1)?.results[0]);
  if (!released) return { released: false, changedProductIds: [] };

  const changedProductIds = targets.flatMap((target, index) => {
    const after = results[index]?.results[0]?.stock;
    return typeof after === 'number' &&
      visibleStockChanged(target.variantId != null, after - target.quantity, after)
      ? [target.productId]
      : [];
  });
  return { released: true, changedProductIds };
}

/** Release one still-active reservation and put its inventory back exactly once. */
export async function releaseInventoryReservation(
  db: D1Database,
  publicId: string,
  purger?: StockTransitionPurger,
): Promise<boolean> {
  const result = await releaseReservation(db, publicId);
  await purgeTransitions(db, result.changedProductIds, purger);
  return result.released;
}

/**
 * Reclaim expired self-rendered Lightning and Demo payments before a new hold.
 * Hosted methods release only from verified provider expiry/failure webhooks: a
 * payment may have completed before local expiry while its webhook is delayed.
 */
export async function releaseExpiredReservations(
  db: D1Database,
  limit = 50,
  purger?: StockTransitionPurger,
): Promise<void> {
  const { results } = await db
    .prepare(
      "SELECT public_id FROM checkout_reservations WHERE payment_method IN ('lightning', 'demo') AND status = 'active' AND expires_at <= datetime('now') ORDER BY expires_at LIMIT ?",
    )
    .bind(limit)
    .all<{ public_id: string }>();
  const changedProductIds: number[] = [];
  for (const row of results ?? []) {
    const released = await releaseReservation(db, row.public_id);
    changedProductIds.push(...released.changedProductIds);
  }
  await purgeTransitions(db, changedProductIds, purger);
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
  paymentMethod: 'stripe' | 'opennode' | 'lightning' | 'demo',
  purger?: StockTransitionPurger,
): Promise<boolean> {
  if (items.length === 0 || !Number.isInteger(ttlSeconds) || ttlSeconds < 60) return false;
  await releaseExpiredReservations(db, 50, purger);

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
          .prepare(
            `UPDATE products SET stock = stock - ? WHERE id = ? AND ${activeGuard} RETURNING stock`,
          )
          .bind(target.quantity, target.productId, publicId)
      : db
          .prepare(
            `UPDATE product_variants SET stock = stock - ? WHERE id = ? AND ${activeGuard} RETURNING stock`,
          )
          .bind(target.quantity, target.variantId, publicId),
  );
  const results = await db.batch<StockUpdateRow & { public_id?: string }>([insert, ...decrements]);
  const reserved = Boolean(results[0]?.results[0]);
  if (!reserved) return false;

  const changedProductIds = targets.flatMap((target, index) => {
    const after = results[index + 1]?.results[0]?.stock;
    return typeof after === 'number' &&
      visibleStockChanged(target.variantId != null, after + target.quantity, after)
      ? [target.productId]
      : [];
  });
  await purgeTransitions(db, changedProductIds, purger);
  return true;
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
