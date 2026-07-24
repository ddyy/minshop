import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import {
  getActiveReservationItems,
  markInventoryReservationPaymentPending,
  releaseExpiredReservations,
  releaseInventoryReservation,
  reserveInventory,
} from '../src/features/orders/reservations.ts';
import { recordPaidOrder } from '../src/features/orders/db.ts';
import { pendingToPaidOrder } from '../src/features/payments/lightning/pending.ts';

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  compatibilityDate: '2026-07-20',
  d1Databases: ['DB'],
});

try {
  const db = await mf.getD1Database('DB');
  // Minimal production-shaped schema for the reservation state machine. The
  // separate Wrangler integration gate applies every real migration clean-room.
  for (const sql of [
    'CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT NOT NULL, price_cents INTEGER NOT NULL, currency TEXT NOT NULL, stock INTEGER NOT NULL, active INTEGER NOT NULL)',
    'CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_session_id TEXT NOT NULL UNIQUE, public_id TEXT NOT NULL UNIQUE, email TEXT, amount_total_cents INTEGER NOT NULL, shipping_cents INTEGER NOT NULL DEFAULT 0, discount_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL, ship_address TEXT, status TEXT NOT NULL, payment_method TEXT, settlement_token TEXT)',
    'CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, product_id INTEGER, variant_id INTEGER, name TEXT NOT NULL, price_cents INTEGER NOT NULL, quantity INTEGER NOT NULL)',
    'CREATE TABLE product_variants (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, label TEXT NOT NULL, price_delta_cents INTEGER NOT NULL DEFAULT 0, stock INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)',
    "CREATE TABLE checkout_reservations (public_id TEXT PRIMARY KEY, items TEXT NOT NULL, payment_method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  ]) {
    await db.exec(sql);
  }

  await db
    .prepare(
      `INSERT INTO products (name, slug, description, price_cents, currency, stock, active)
       VALUES ('Reserved product', 'reserved-product', '', 1200, 'usd', 5, 1)`,
    )
    .run();
  const product = await db
    .prepare("SELECT id FROM products WHERE slug = 'reserved-product'")
    .first();
  assert(product?.id);

  const item = {
    productId: product.id,
    name: 'Reserved product',
    priceCents: 1200,
    quantity: 4,
  };

  // Two competing holds cannot both consume the same finite stock.
  const concurrent = await Promise.all([
    reserveInventory(db, crypto.randomUUID(), [item], 600, 'lightning'),
    reserveInventory(db, crypto.randomUUID(), [item], 600, 'lightning'),
  ]);
  assert.equal(concurrent.filter(Boolean).length, 1);
  assert.equal((await db.prepare('SELECT stock FROM products WHERE id = ?').bind(product.id).first()).stock, 1);

  const active = await db
    .prepare("SELECT public_id FROM checkout_reservations WHERE status = 'active'")
    .first();
  assert(active?.public_id);
  await markInventoryReservationPaymentPending(db, active.public_id);
  await db
    .prepare("UPDATE checkout_reservations SET expires_at = datetime('now', '-1 minute') WHERE public_id = ?")
    .bind(active.public_id)
    .run();
  await releaseExpiredReservations(db);
  assert(await getActiveReservationItems(db, active.public_id));
  assert.equal(await releaseInventoryReservation(db, active.public_id), true);
  assert.equal(await releaseInventoryReservation(db, active.public_id), false);
  assert.equal((await db.prepare('SELECT stock FROM products WHERE id = ?').bind(product.id).first()).stock, 5);

  // Settlement consumes an active hold once; duplicate delivery is a no-op.
  const reservationId = crypto.randomUUID();
  const settledItem = { ...item, quantity: 2 };
  assert.equal(await reserveInventory(db, reservationId, [settledItem], 600, 'stripe'), true);
  const paid = {
    providerSessionId: 'provider-session-1',
    publicId: reservationId,
    reservationId,
    email: 'buyer@example.com',
    amountTotalCents: 2400,
    currency: 'usd',
    items: [settledItem],
  };
  assert(await recordPaidOrder(db, paid));
  assert.equal(await recordPaidOrder(db, paid), null);
  assert.equal((await db.prepare('SELECT stock FROM products WHERE id = ?').bind(product.id).first()).stock, 3);
  assert.equal(
    (await db.prepare('SELECT status FROM checkout_reservations WHERE public_id = ?').bind(reservationId).first()).status,
    'settled',
  );
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM order_items').first()).n, 1);

  // Expired ordinary holds are reclaimed lazily.
  const expiredId = crypto.randomUUID();
  assert.equal(
    await reserveInventory(db, expiredId, [{ ...item, quantity: 1 }], 600, 'lightning'),
    true,
  );
  await db
    .prepare("UPDATE checkout_reservations SET expires_at = datetime('now', '-1 minute') WHERE public_id = ?")
    .bind(expiredId)
    .run();
  await releaseExpiredReservations(db);
  assert.equal(
    (await db.prepare('SELECT status FROM checkout_reservations WHERE public_id = ?').bind(expiredId).first()).status,
    'released',
  );
  assert.equal((await db.prepare('SELECT stock FROM products WHERE id = ?').bind(product.id).first()).stock, 3);

  // Hosted holds never release from the local clock alone: a paid provider
  // webhook may be delayed, so only a verified expiry/failure can return them.
  const hostedId = crypto.randomUUID();
  assert.equal(
    await reserveInventory(db, hostedId, [{ ...item, quantity: 1 }], 600, 'stripe'),
    true,
  );
  await db
    .prepare("UPDATE checkout_reservations SET expires_at = datetime('now', '-1 minute') WHERE public_id = ?")
    .bind(hostedId)
    .run();
  await releaseExpiredReservations(db);
  assert.equal(
    (await db.prepare('SELECT status FROM checkout_reservations WHERE public_id = ?').bind(hostedId).first()).status,
    'active',
  );
  assert.equal((await db.prepare('SELECT stock FROM products WHERE id = ?').bind(product.id).first()).stock, 2);
  assert.equal(await releaseInventoryReservation(db, hostedId), true);
  assert.equal((await db.prepare('SELECT stock FROM products WHERE id = ?').bind(product.id).first()).stock, 3);

  // A pre-0021 pending row has no explicit reservation and keeps legacy stock settlement.
  const legacy = pendingToPaidOrder({
    id: 1,
    public_id: crypto.randomUUID(),
    payment_hash: 'legacy-payment',
    backend: 'opennode',
    bolt11: null,
    amount_sat: null,
    amount_total_cents: 1200,
    currency: 'usd',
    email: null,
    items: JSON.stringify([{ id: product.id, q: 1, n: 'Reserved product', p: 1200 }]),
    shipping_cents: 0,
    ship_address: null,
    reservation_id: null,
    status: 'pending',
    expires_at: null,
    created_at: '2026-07-20 00:00:00',
  });
  assert.equal(legacy.reservationId, undefined);
  assert(await recordPaidOrder(db, legacy));
  assert.equal((await db.prepare('SELECT stock FROM products WHERE id = ?').bind(product.id).first()).stock, 2);

  console.log('Reservation integration passed: concurrency + pending + release + settlement + legacy');
} finally {
  await mf.dispose();
}
