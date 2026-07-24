import type { D1Database } from '@cloudflare/workers-types';

export interface ShippingAddress {
  name: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postal: string | null;
  country: string | null;
}

export interface Order {
  id: number;
  public_id: string | null;
  provider_session_id: string | null;
  email: string | null;
  amount_total_cents: number;
  shipping_cents: number;
  discount_cents: number;
  tax_cents: number;
  currency: string;
  status: string; // payment status (e.g. 'paid' | 'refunded')
  payment_method: string | null; // 'stripe' | 'lightning' | 'opennode' (NULL = legacy/default)
  refunded_cents: number; // total refunded (0 = none; = amount_total_cents when fully refunded)
  fulfillment_status: string; // 'unfulfilled' | 'fulfilled'
  tracking_carrier: string | null;
  tracking_number: string | null;
  fulfilled_at: string | null;
  ship_address: string | null; // JSON snapshot (ShippingAddress) or null
  created_at: string;
}

export interface OrderItemInput {
  productId: number | null;
  variantId?: number | null; // which variant sold (stock target); null = no variant
  name: string;
  priceCents: number;
  quantity: number;
}

/** A persisted order_items row. */
export interface OrderItem {
  id: number;
  order_id: number;
  product_id: number | null;
  variant_id: number | null;
  name: string;
  price_cents: number;
  quantity: number;
}

/** A paid order to persist, in provider-agnostic terms. */
export interface PaidOrderInput {
  providerSessionId: string;
  /** Unguessable public token for the customer-facing order URL. */
  publicId?: string;
  /** Inventory reservation already holding this order's stock. */
  reservationId?: string;
  email: string | null;
  amountTotalCents: number;
  shippingCents?: number;
  discountCents?: number;
  taxCents?: number;
  shippingAddress?: ShippingAddress | null;
  currency: string;
  /** Which rail settled it ('stripe' | 'lightning' | 'opennode'). */
  paymentMethod?: string;
  items?: OrderItemInput[];
}

/** Recent orders for the admin view, newest first. */
export async function listOrders(
  db: D1Database,
  limit = 50,
  orderBy = 'created_at DESC',
  offset = 0,
): Promise<Order[]> {
  const { results } = await db
    .prepare(`SELECT * FROM orders ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .bind(limit, offset)
    .all<Order>();
  return results ?? [];
}

/** Total settled orders, for admin/MCP pagination. */
export async function countOrders(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM orders').first<{ n: number }>();
  return row?.n ?? 0;
}

/** A customer's own orders (for the /account page), newest first. */
export async function listOrdersByEmail(
  db: D1Database,
  email: string,
  limit = 20,
  offset = 0,
): Promise<Order[]> {
  const { results } = await db
    .prepare('SELECT * FROM orders WHERE email = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .bind(email, limit, offset)
    .all<Order>();
  return results ?? [];
}

/** Total orders belonging to one normalized customer email. */
export async function countOrdersByEmail(db: D1Database, email: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM orders WHERE email = ?')
    .bind(email)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface DailyTotal {
  day: string; // YYYY-MM-DD (UTC)
  orders: number;
  total_cents: number;
}

/**
 * Order count + NET revenue per day for the last `days` days (UTC), with
 * zero-filled gaps so the series is continuous for charting. Net = total minus
 * any refunds, so a refunded order stops inflating the day it was placed.
 */
export async function dailyOrderTotals(db: D1Database, days: number): Promise<DailyTotal[]> {
  const { results } = await db
    .prepare(
      `SELECT date(created_at) AS day,
              COUNT(*)                AS orders,
              COALESCE(SUM(amount_total_cents - refunded_cents), 0) AS total_cents
         FROM orders
        WHERE created_at >= date('now', ?)
        GROUP BY day`,
    )
    .bind(`-${days - 1} days`)
    .all<DailyTotal>();
  const byDay = new Map((results ?? []).map((r) => [r.day, r]));

  const out: DailyTotal[] = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    const row = byDay.get(day);
    out.push({ day, orders: row?.orders ?? 0, total_cents: row?.total_cents ?? 0 });
  }
  return out;
}

/**
 * Totals for the dashboard: order count + NET revenue (gross minus refunds) +
 * the amount refunded to date. Net = SUM(amount_total_cents - refunded_cents).
 */
export async function orderStats(
  db: D1Database,
): Promise<{ count: number; revenue_cents: number; refunded_cents: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(amount_total_cents - refunded_cents), 0) AS revenue_cents,
              COALESCE(SUM(refunded_cents), 0)                      AS refunded_cents
         FROM orders`,
    )
    .first<{ count: number; revenue_cents: number; refunded_cents: number }>();
  return {
    count: row?.count ?? 0,
    revenue_cents: row?.revenue_cents ?? 0,
    refunded_cents: row?.refunded_cents ?? 0,
  };
}

/** Single order by id, or null if missing. */
export async function getOrder(db: D1Database, id: number): Promise<Order | null> {
  return db.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first<Order>();
}

/** Set the payment status (e.g. 'paid' → 'refunded'). */
export async function setOrderStatus(
  db: D1Database,
  id: number,
  status: string,
): Promise<void> {
  await db.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(status, id).run();
}

/**
 * Record a refund of `cents` on an order: add to refunded_cents and flip status
 * to 'refunded' once fully refunded. Caps refunded_cents at the order total so a
 * double-submit can't push net revenue negative. Returns the new refunded total.
 */
export async function recordRefund(
  db: D1Database,
  id: number,
  cents: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE orders
         SET refunded_cents = MIN(amount_total_cents, refunded_cents + ?),
             status = CASE WHEN MIN(amount_total_cents, refunded_cents + ?) >= amount_total_cents
                           THEN 'refunded' ELSE status END
       WHERE id = ?`,
    )
    .bind(cents, cents, id)
    .run();
}

/** Single order by its public token, or null if missing (customer-facing). */
export async function getOrderByPublicId(db: D1Database, publicId: string): Promise<Order | null> {
  return db.prepare('SELECT * FROM orders WHERE public_id = ?').bind(publicId).first<Order>();
}

/** Find an already-settled order by the provider's idempotency/session id. */
export async function getOrderByProviderSessionId(
  db: D1Database,
  providerSessionId: string,
): Promise<Order | null> {
  return db
    .prepare('SELECT * FROM orders WHERE provider_session_id = ?')
    .bind(providerSessionId)
    .first<Order>();
}

/** Mark an order fulfilled (shipped) with tracking details. */
export async function fulfillOrder(
  db: D1Database,
  id: number,
  carrier: string | null,
  trackingNumber: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE orders
         SET fulfillment_status = 'fulfilled', tracking_carrier = ?, tracking_number = ?,
             fulfilled_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(carrier, trackingNumber, id)
    .run();
}

/** Revert an order to unfulfilled, clearing tracking. */
export async function unfulfillOrder(db: D1Database, id: number): Promise<void> {
  await db
    .prepare(
      `UPDATE orders
         SET fulfillment_status = 'unfulfilled', tracking_carrier = NULL,
             tracking_number = NULL, fulfilled_at = NULL
       WHERE id = ?`,
    )
    .bind(id)
    .run();
}

/** Line items for an order, in insertion order. */
export async function listOrderItems(db: D1Database, orderId: number): Promise<OrderItem[]> {
  const { results } = await db
    .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id')
    .bind(orderId)
    .all<OrderItem>();
  return results ?? [];
}

export interface OrderItemWithImage extends OrderItem {
  image_key: string | null;
}

/** Line items joined to the product's current image_key (for email thumbnails). */
export async function listOrderItemsWithImages(
  db: D1Database,
  orderId: number,
): Promise<OrderItemWithImage[]> {
  const { results } = await db
    .prepare(
      `SELECT oi.*, p.image_key
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ? ORDER BY oi.id`,
    )
    .bind(orderId)
    .all<OrderItemWithImage>();
  return results ?? [];
}

/**
 * Record a paid order and write its line items. New real checkouts atomically
 * reserve stock before leaving the store, so settlement consumes that reservation
 * without decrementing twice. Legacy/unreserved orders retain the old settlement
 * decrement path for rolling-deploy compatibility.
 *
 * Idempotent on the provider session id (column is `provider_session_id` for
 * historical reasons; holds whichever provider's session id). A unique settlement
 * token claims the order inside the SAME D1 batch that inserts the header + items
 * and decrements stock. Parallel/re-delivered webhooks therefore cannot both apply
 * inventory, and any batch failure rolls the entire order back for a clean retry.
 * The return value is the claimed order id, or null when another delivery already
 * completed it; callers use that to send confirmation email once after commit.
 *
 * Demo orders (`paymentMethod === 'demo'`) record their items but NEVER touch real
 * stock — demo is a simulation, so anonymous demo checkouts can't drain inventory.
 */
export async function recordPaidOrder(
  db: D1Database,
  o: PaidOrderInput,
): Promise<number | null> {
  const publicId = o.publicId ?? crypto.randomUUID();
  const settlementToken = crypto.randomUUID();
  const orderValues = [
    o.providerSessionId,
    publicId,
    o.email,
    o.amountTotalCents,
    o.shippingCents ?? 0,
    o.discountCents ?? 0,
    o.taxCents ?? 0,
    o.currency,
    o.shippingAddress ? JSON.stringify(o.shippingAddress) : null,
    o.paymentMethod ?? null,
  ] as const;
  const insertOrder = o.reservationId
    ? db
        .prepare(
          `INSERT INTO orders (provider_session_id, public_id, email, amount_total_cents, shipping_cents, discount_cents, tax_cents, currency, ship_address, status, payment_method, settlement_token)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, NULL
            WHERE EXISTS (
              SELECT 1 FROM checkout_reservations
               WHERE public_id = ? AND status IN ('active', 'payment_pending')
            )
           ON CONFLICT(provider_session_id) DO NOTHING
           RETURNING id`,
        )
        .bind(...orderValues, o.reservationId)
    : db
        .prepare(
          `INSERT INTO orders (provider_session_id, public_id, email, amount_total_cents, shipping_cents, discount_cents, tax_cents, currency, ship_address, status, payment_method, settlement_token)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, NULL)
           ON CONFLICT(provider_session_id) DO NOTHING
           RETURNING id`,
        )
        .bind(...orderValues);
  const stmts = [
    insertOrder,
    // Only one delivery can change NULL to its unique token. Every following
    // statement is conditional on that token, so a concurrent loser is a no-op.
    db
      .prepare(
        `UPDATE orders SET settlement_token = ?
          WHERE provider_session_id = ? AND settlement_token IS NULL
          RETURNING id`,
      )
      .bind(settlementToken, o.providerSessionId),
  ];

  const items = o.items ?? [];
  const skipStock = o.paymentMethod === 'demo' || Boolean(o.reservationId);
  for (const it of items) {
    const variantId = it.variantId ?? null;
    stmts.push(
      db
        .prepare(
          `INSERT INTO order_items (order_id, product_id, variant_id, name, price_cents, quantity)
           SELECT id, ?, ?, ?, ?, ? FROM orders
            WHERE provider_session_id = ? AND settlement_token = ?`,
        )
        .bind(
          it.productId,
          variantId,
          it.name,
          it.priceCents,
          it.quantity,
          o.providerSessionId,
          settlementToken,
        ),
    );
    // Demo orders record the full simulation without touching real inventory.
    if (skipStock) continue;
    if (variantId != null) {
      stmts.push(
        db
          .prepare(
            `UPDATE product_variants SET stock = MAX(0, stock - ?)
              WHERE id = ? AND EXISTS (
                SELECT 1 FROM orders
                 WHERE provider_session_id = ? AND settlement_token = ?
              )`,
          )
          .bind(it.quantity, variantId, o.providerSessionId, settlementToken),
      );
    } else if (it.productId != null) {
      stmts.push(
        db
          .prepare(
            `UPDATE products SET stock = MAX(0, stock - ?)
              WHERE id = ? AND EXISTS (
                SELECT 1 FROM orders
                 WHERE provider_session_id = ? AND settlement_token = ?
              )`,
          )
          .bind(it.quantity, it.productId, o.providerSessionId, settlementToken),
      );
    }
  }

  if (o.reservationId) {
    stmts.push(
      db
        .prepare(
          `UPDATE checkout_reservations SET status = 'settled'
            WHERE public_id = ? AND status IN ('active', 'payment_pending') AND EXISTS (
              SELECT 1 FROM orders
               WHERE provider_session_id = ? AND settlement_token = ?
            )`,
        )
        .bind(o.reservationId, o.providerSessionId, settlementToken),
    );
  }

  const results = await db.batch<{ id: number }>(stmts);
  const claimed = results[1]?.results[0];
  return claimed?.id ?? null;
}
