import type { D1Database } from '@cloudflare/workers-types';
import {
  visibleStockChanged,
  type StockTransitionPurger,
} from '../products/stock.ts';
import type { OrderItemInput } from './db';
import { generatePublicId, isPublicIdConflict } from '../ids/publicId.ts';
import {
  DIGITAL_DELIVERY_RELEASE,
  lifecycleActive,
  type DigitalDeliveryRelease,
} from '../digitalDelivery/rollout.ts';

export interface ReservationItem extends OrderItemInput {
  productId: number;
  publicId?: string;
  fileKey?: string | null;
  fileName?: string | null;
  fileMime?: string | null;
  fileSizeBytes?: number | null;
}

export type ReservationStatus =
  | 'active'
  | 'payment_pending'
  | 'settled'
  | 'released'
  | 'expired'
  | 'failed';

interface ReservationRow {
  public_id: string;
  items: string;
  status: ReservationStatus;
  expires_at: string;
  terminal_at: string | null;
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
          (item.publicId != null && (typeof item.publicId !== 'string' || !item.publicId.startsWith('itm_'))) ||
          (item.fileKey != null && typeof item.fileKey !== 'string') ||
          (item.fileName != null && typeof item.fileName !== 'string') ||
          (item.fileMime != null && typeof item.fileMime !== 'string') ||
          (item.fileSizeBytes != null && (!Number.isInteger(item.fileSizeBytes) || item.fileSizeBytes < 0)) ||
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
    .prepare('SELECT public_id, items, status, expires_at, terminal_at FROM checkout_reservations WHERE public_id = ?')
    .bind(publicId)
    .first<ReservationRow>();
}

const ITEM_ID_LOOKUP_CHUNK = 40;

async function hasClaimedItemId(db: D1Database, publicIds: string[]): Promise<boolean> {
  for (let offset = 0; offset < publicIds.length; offset += ITEM_ID_LOOKUP_CHUNK) {
    const chunk = publicIds.slice(offset, offset + ITEM_ID_LOOKUP_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const existing = await db
      .prepare(
        `SELECT public_id FROM order_items WHERE public_id IN (${placeholders})
         UNION ALL SELECT public_id FROM order_item_ids WHERE public_id IN (${placeholders}) LIMIT 1`,
      )
      .bind(...chunk, ...chunk)
      .first<{ public_id: string }>();
    if (existing) return true;
  }
  return false;
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
  terminalStatus: 'released' | 'expired' | 'failed' = 'released',
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
        `UPDATE checkout_reservations
            SET status = ?, terminal_at = CASE WHEN ? = 'released' THEN terminal_at ELSE datetime('now') END
          WHERE public_id = ? AND status IN ('active', 'payment_pending')
          RETURNING public_id`,
      )
      .bind(terminalStatus, terminalStatus, publicId),
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

/** Release stock for a provider-confirmed terminal result while retaining its snapshot. */
export async function markInventoryReservationTerminal(
  db: D1Database,
  publicId: string,
  status: 'expired' | 'failed',
  purger?: StockTransitionPurger,
): Promise<boolean> {
  const result = await releaseReservation(db, publicId, lifecycleActive() ? status : 'released');
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
    const released = await releaseReservation(
      db,
      row.public_id,
      lifecycleActive() ? 'expired' : 'released',
    );
    changedProductIds.push(...released.changedProductIds);
  }
  await purgeTransitions(db, changedProductIds, purger);
}

/** Expire one locally authoritative self-rendered hold during a status read. */
export async function expireSelfRenderedReservation(
  db: D1Database,
  publicId: string,
  purger?: StockTransitionPurger,
): Promise<boolean> {
  const eligible = await db
    .prepare(
      `SELECT public_id FROM checkout_reservations
       WHERE public_id = ? AND payment_method IN ('lightning', 'demo')
         AND status = 'active' AND expires_at <= datetime('now')`,
    )
    .bind(publicId)
    .first<{ public_id: string }>();
  if (!eligible) return false;
  const released = await releaseReservation(
    db,
    publicId,
    lifecycleActive() ? 'expired' : 'released',
  );
  await purgeTransitions(db, released.changedProductIds, purger);
  return released.released;
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
  release: DigitalDeliveryRelease = DIGITAL_DELIVERY_RELEASE,
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

  let results: D1Result<(StockUpdateRow & { public_id?: string })>[] | null = null;
  let claimedItems: ReservationItem[] = [];
  let claimStatementCount = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    claimedItems = items.map((item) => ({
      ...item,
      publicId: item.publicId ?? (lifecycleActive(release) ? generatePublicId('orderItem') : undefined),
    }));

    // Transitional guard while historical order-item IDs are being registered.
    if (
      lifecycleActive(release) &&
      (await hasClaimedItemId(db, claimedItems.map((item) => item.publicId!)))
    ) {
      items = items.map((item) => ({ ...item, publicId: undefined }));
      continue;
    }

    const insert = db
      .prepare(
        `INSERT INTO checkout_reservations (public_id, items, payment_method, expires_at)
         SELECT ?, ?, ?, datetime('now', ?)
          WHERE ${checks.join(' AND ')}
         ON CONFLICT(public_id) DO NOTHING
         RETURNING public_id`,
      )
      .bind(publicId, JSON.stringify(claimedItems), paymentMethod, `+${ttlSeconds} seconds`, ...checkValues);
    // Release 1 writes no claims, so the decrement results sit at a different
    // offset there. Index off the statements actually batched, never off the
    // item count — getting this wrong silently skips every stock purge.
    const claims = lifecycleActive(release) ? claimedItems.map((item) =>
      db
        .prepare(
          `INSERT INTO order_item_ids (public_id, order_public_id)
           SELECT ?, ? WHERE EXISTS (
             SELECT 1 FROM checkout_reservations WHERE public_id = ? AND status = 'active'
           )`,
        )
        .bind(item.publicId, publicId, publicId),
    ) : [];
    claimStatementCount = claims.length;
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
    try {
      results = await db.batch<StockUpdateRow & { public_id?: string }>([insert, ...claims, ...decrements]);
      break;
    } catch (err) {
      if (!isPublicIdConflict(err)) throw err;
      items = items.map((item) => ({ ...item, publicId: undefined }));
    }
  }
  if (!results) throw new Error('order item identity collision retry exhausted');
  const reserved = Boolean(results[0]?.results[0]);
  if (!reserved) return false;

  const changedProductIds = targets.flatMap((target, index) => {
    const after = results[index + 1 + claimStatementCount]?.results[0]?.stock;
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

export interface SettlementReservation {
  items: ReservationItem[];
  status: ReservationStatus;
}

/** Load an authoritative snapshot for ordinary or late settlement. */
export async function getSettlementReservation(
  db: D1Database,
  publicId: string,
): Promise<SettlementReservation | null> {
  const row = await getReservation(db, publicId);
  if (!row || !['active', 'payment_pending', 'expired', 'failed'].includes(row.status)) return null;
  const items = parseItems(row.items);
  return items ? { items, status: row.status } : null;
}

/** Snapshot used by the unadvertised machine-readable status route. */
export async function getReservationStatusSnapshot(
  db: D1Database,
  publicId: string,
): Promise<SettlementReservation | null> {
  const row = await getReservation(db, publicId);
  if (!row) return null;
  const items = parseItems(row.items);
  return items ? { items, status: row.status } : null;
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
