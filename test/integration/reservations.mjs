import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import {
  getActiveReservationItems,
  getSettlementReservation,
  getReservationStatusSnapshot,
  expireSelfRenderedReservation,
  markInventoryReservationPaymentPending,
  releaseExpiredReservations,
  releaseInventoryReservation,
  reserveInventory,
} from '../../src/features/orders/reservations.ts';
import { reservationItems } from '../../src/features/orders/reservationItems.ts';
import { recordPaidOrder } from '../../src/features/orders/db.ts';
import { pendingToPaidOrder } from '../../src/features/payments/lightning/pending.ts';
import {
  claimNotification,
  markNotificationSent,
  MAX_ATTEMPTS,
} from '../../src/features/email/outboxStore.ts';

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
    'CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT UNIQUE, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT NOT NULL, price_cents INTEGER NOT NULL, currency TEXT NOT NULL, stock INTEGER NOT NULL, active INTEGER NOT NULL, file_key TEXT, file_name TEXT, file_mime TEXT, file_size_bytes INTEGER)',
    'CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_session_id TEXT NOT NULL UNIQUE, public_id TEXT NOT NULL UNIQUE, email TEXT, amount_total_cents INTEGER NOT NULL, shipping_cents INTEGER NOT NULL DEFAULT 0, shipping_label TEXT, shipping_weight_grams INTEGER, delivery_method TEXT, discount_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL, ship_address TEXT, status TEXT NOT NULL, payment_method TEXT, settlement_token TEXT, provider_payment_id TEXT)',
    'CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, product_id INTEGER, variant_id INTEGER, name TEXT NOT NULL, price_cents INTEGER NOT NULL, quantity INTEGER NOT NULL, public_id TEXT UNIQUE, file_key TEXT, file_name TEXT, file_mime TEXT, file_size_bytes INTEGER, downloads INTEGER NOT NULL DEFAULT 0)',
    'CREATE TABLE product_variants (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, label TEXT NOT NULL, price_delta_cents INTEGER NOT NULL DEFAULT 0, stock INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)',
    "CREATE TABLE checkout_reservations (public_id TEXT PRIMARY KEY, items TEXT NOT NULL, payment_method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', expires_at TEXT NOT NULL, terminal_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE TABLE order_item_ids (public_id TEXT PRIMARY KEY, order_public_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE TABLE order_inventory_exceptions (id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT NOT NULL UNIQUE, order_id INTEGER NOT NULL, product_id INTEGER NOT NULL, variant_id INTEGER, requested_qty INTEGER NOT NULL, consumed_qty INTEGER NOT NULL, shortfall_qty INTEGER NOT NULL, resolved_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    // Just the columns recordPaidOrder's batched settle statement touches.
    "CREATE TABLE pending_payments (payment_hash TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending')",
    // Outbox rows are born inside the same batch (0032).
    "CREATE TABLE order_notifications (order_id INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT, last_error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT, PRIMARY KEY (order_id, kind))",
  ]) {
    await db.exec(sql);
  }

  await db
    .prepare(
      `INSERT INTO products (public_id, name, slug, description, price_cents, currency, stock, active)
       VALUES ('prod_0123456789', 'Reserved product', 'reserved-product', '', 1200, 'usd', 5, 1)`,
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

  // Item identity preflight stays below D1's 100-variable cap even for a cart
  // with more than 50 distinct lines.
  await db
    .prepare(
      `INSERT INTO products (public_id, name, slug, description, price_cents, currency, stock, active)
       VALUES ('prod_many123456', 'Many lines', 'many-lines', '', 1, 'usd', 100, 1)`,
    )
    .run();
  const manyProduct = await db.prepare("SELECT id FROM products WHERE slug = 'many-lines'").first();
  const manyId = crypto.randomUUID();
  const manyItems = Array.from({ length: 60 }, (_, index) => ({
    productId: manyProduct.id,
    name: `Line ${index + 1}`,
    priceCents: 1,
    quantity: 1,
  }));
  assert.equal(await reserveInventory(db, manyId, manyItems, 600, 'demo'), true);
  assert.equal(await releaseInventoryReservation(db, manyId), true);

  // A status read can expire a locally authoritative self-rendered hold
  // immediately; hosted rails remain untouched by this helper.
  const statusExpiryId = crypto.randomUUID();
  assert.equal(await reserveInventory(db, statusExpiryId, [{ ...item, quantity: 1 }], 600, 'demo'), true);
  await db
    .prepare("UPDATE checkout_reservations SET expires_at = datetime('now', '-1 minute') WHERE public_id = ?")
    .bind(statusExpiryId)
    .run();
  assert.equal(await expireSelfRenderedReservation(db, statusExpiryId), true);
  assert.equal((await getSettlementReservation(db, statusExpiryId)).status, 'expired');

  // Cache invalidation follows rendered state, not every decrement. Product
  // quantities purge only when they cross in/low/out; variant quantities purge
  // only when their available/sold-out boolean flips.
  await db
    .prepare(
      `INSERT INTO products (public_id, name, slug, description, price_cents, currency, stock, active)
       VALUES ('prod_abcdefghj', 'Transition product', 'transition-product', '', 1200, 'usd', 7, 1)`,
    )
    .run();
  const transitionProduct = await db
    .prepare("SELECT id FROM products WHERE slug = 'transition-product'")
    .first();
  assert(transitionProduct?.id);
  const purges = [];
  const collectPurge = async (ids) => purges.push([...ids]);
  const transitionItem = {
    productId: transitionProduct.id,
    name: 'Transition product',
    priceCents: 1200,
    quantity: 1,
  };
  const firstTransition = crypto.randomUUID();
  const secondTransition = crypto.randomUUID();
  assert.equal(
    await reserveInventory(
      db,
      firstTransition,
      [transitionItem],
      600,
      'lightning',
      collectPurge,
    ),
    true,
  );
  assert.deepEqual(purges, []); // 7 → 6 stays "in"
  assert.equal(
    await reserveInventory(
      db,
      secondTransition,
      [transitionItem],
      600,
      'lightning',
      collectPurge,
    ),
    true,
  );
  assert.deepEqual(purges, [['prod_abcdefghj']]); // 6 → 5 enters "low"
  assert.equal(
    await releaseInventoryReservation(db, secondTransition, collectPurge),
    true,
  );
  assert.deepEqual(purges, [['prod_abcdefghj'], ['prod_abcdefghj']]); // 5 → 6 leaves "low"
  assert.equal(
    await releaseInventoryReservation(db, firstTransition, collectPurge),
    true,
  );
  assert.equal(purges.length, 2); // 6 → 7 stays "in"

  await db
    .prepare(
      `INSERT INTO product_variants (product_id, label, stock)
       VALUES (?, 'Limited', 2)`,
    )
    .bind(transitionProduct.id)
    .run();
  const transitionVariant = await db
    .prepare("SELECT id FROM product_variants WHERE product_id = ? AND label = 'Limited'")
    .bind(transitionProduct.id)
    .first();
  assert(transitionVariant?.id);
  const variantItem = { ...transitionItem, variantId: transitionVariant.id };
  const firstVariant = crypto.randomUUID();
  const secondVariant = crypto.randomUUID();
  assert.equal(
    await reserveInventory(db, firstVariant, [variantItem], 600, 'lightning', collectPurge),
    true,
  );
  assert.equal(purges.length, 2); // 2 → 1 stays available
  assert.equal(
    await reserveInventory(db, secondVariant, [variantItem], 600, 'lightning', collectPurge),
    true,
  );
  assert.equal(purges.length, 3); // 1 → 0 becomes sold out
  assert.equal(
    await releaseInventoryReservation(db, secondVariant, collectPurge),
    true,
  );
  assert.equal(purges.length, 4); // 0 → 1 becomes available
  assert.equal(
    await releaseInventoryReservation(db, firstVariant, collectPurge),
    true,
  );
  assert.equal(purges.length, 4); // 1 → 2 stays available

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

  // Demo uses the same hold-and-settle lifecycle: checkout decrements once,
  // approval settles the hold, and settlement cannot decrement a second time.
  await db
    .prepare(
      `INSERT INTO products (public_id, name, slug, description, price_cents, currency, stock, active)
       VALUES ('prod_dem0123456', 'Demo product', 'demo-product', '', 900, 'usd', 2, 1)`,
    )
    .run();
  const demoProduct = await db
    .prepare("SELECT id FROM products WHERE slug = 'demo-product'")
    .first();
  assert(demoProduct?.id);
  const demoReservationId = crypto.randomUUID();
  const demoItem = {
    productId: demoProduct.id,
    name: 'Demo product',
    priceCents: 900,
    quantity: 1,
  };
  assert.equal(
    await reserveInventory(db, demoReservationId, [demoItem], 600, 'demo'),
    true,
  );
  assert.equal(
    (await db.prepare('SELECT stock FROM products WHERE id = ?').bind(demoProduct.id).first()).stock,
    1,
  );
  assert(
    await recordPaidOrder(db, {
      providerSessionId: 'demo-session-1',
      publicId: demoReservationId,
      reservationId: demoReservationId,
      email: 'demo@example.com',
      amountTotalCents: 900,
      currency: 'usd',
      paymentMethod: 'demo',
      items: [demoItem],
    }),
  );
  assert.equal(
    (await db.prepare('SELECT stock FROM products WHERE id = ?').bind(demoProduct.id).first()).stock,
    1,
  );
  assert.equal(
    (
      await db
        .prepare('SELECT status FROM checkout_reservations WHERE public_id = ?')
        .bind(demoReservationId)
        .first()
    ).status,
    'settled',
  );

  // An abandoned Demo hold is safe to reclaim from its local expiry because the
  // self-rendered pay page also refuses settlement after that timestamp.
  const expiredDemoId = crypto.randomUUID();
  assert.equal(
    await reserveInventory(db, expiredDemoId, [demoItem], 600, 'demo'),
    true,
  );
  await db
    .prepare("UPDATE checkout_reservations SET expires_at = datetime('now', '-1 minute') WHERE public_id = ?")
    .bind(expiredDemoId)
    .run();
  await releaseExpiredReservations(db);
  assert.equal(
    (
      await db
        .prepare('SELECT status FROM checkout_reservations WHERE public_id = ?')
        .bind(expiredDemoId)
        .first()
    ).status,
    'expired',
  );
  assert.equal(
    (await db.prepare('SELECT stock FROM products WHERE id = ?').bind(demoProduct.id).first()).stock,
    1,
  );

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
    'expired',
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
  assert.equal(legacy.settlePaymentHash, 'legacy-payment');
  await db
    .prepare("INSERT INTO pending_payments (payment_hash, status) VALUES ('legacy-payment', 'pending')")
    .run();
  assert(await recordPaidOrder(db, legacy));
  assert.equal((await db.prepare('SELECT stock FROM products WHERE id = ?').bind(product.id).first()).stock, 2);
  // The batched settle: recording the order flipped its pending row.
  assert.equal(
    (await db.prepare("SELECT status FROM pending_payments WHERE payment_hash = 'legacy-payment'").first()).status,
    'settled',
  );
  // Outbox rows born atomically with the order — one per email kind, pending.
  assert.equal(
    (await db.prepare(
      `SELECT COUNT(*) AS n FROM order_notifications
        WHERE state = 'pending'
          AND order_id = (SELECT id FROM orders WHERE provider_session_id = 'legacy-payment')`,
    ).first()).n,
    2,
  );

  // A reservation-gated order whose reservation is gone must NOT settle its
  // pending row: the guard ties the settle to this batch's claimed order.
  await db
    .prepare("INSERT INTO pending_payments (payment_hash, status) VALUES ('blocked-payment', 'pending')")
    .run();
  assert.equal(
    await recordPaidOrder(db, {
      providerSessionId: 'blocked-payment',
      publicId: crypto.randomUUID(),
      reservationId: crypto.randomUUID(), // no such reservation
      email: null,
      amountTotalCents: 1200,
      currency: 'usd',
      items: [{ productId: product.id, name: 'Reserved product', priceCents: 1200, quantity: 1 }],
      settlePaymentHash: 'blocked-payment',
    }),
    null,
  );
  assert.equal(
    (await db.prepare("SELECT status FROM pending_payments WHERE payment_hash = 'blocked-payment'").first()).status,
    'pending',
  );
  // ...and no outbox rows either: no order, no email intent. (6 = the three
  // successful orders above × two kinds; the blocked one added none.)
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM order_notifications').first()).n, 6);

  // Outbox state machine against REAL D1 — the exact statements outboxStore.ts
  // ships, not a unit-test interpretation of them: claim exclusivity, expired-
  // lease reclaim, the fencing token, and the spent-attempts park.
  const nid = (await db
    .prepare("SELECT id FROM orders WHERE provider_session_id = 'legacy-payment'")
    .first()).id;
  const KIND = 'customer-receipt';
  const notifRow = () =>
    db
      .prepare('SELECT state, attempts, lease_expires_at FROM order_notifications WHERE order_id = ? AND kind = ?')
      .bind(nid, KIND)
      .first();

  // Claim wins once; a second claim against the live lease loses.
  assert.equal(await claimNotification(db, nid, KIND), 1);
  assert.equal(await claimNotification(db, nid, KIND), null);
  assert.equal((await notifRow()).state, 'processing');

  // Lease expires → reclaimable, attempts advance.
  await db
    .prepare("UPDATE order_notifications SET lease_expires_at = datetime('now', '-1 minute') WHERE order_id = ? AND kind = ?")
    .bind(nid, KIND)
    .run();
  assert.equal(await claimNotification(db, nid, KIND), 2);

  // Fencing: the stale claim's completion (token 1) must NOT stick...
  await markNotificationSent(db, nid, KIND, 1);
  assert.equal((await notifRow()).state, 'processing');
  // ...while the live claim's (token 2) does.
  await markNotificationSent(db, nid, KIND, 2);
  assert.equal((await notifRow()).state, 'sent');

  // Spent-attempts park: an abandoned claim with no attempts left goes dead
  // instead of being reclaimed forever.
  await db
    .prepare(
      `UPDATE order_notifications
          SET state = 'processing', attempts = ?, lease_expires_at = datetime('now', '-1 minute'), last_error = NULL
        WHERE order_id = ? AND kind = 'owner-notification'`,
    )
    .bind(MAX_ATTEMPTS, nid)
    .run();
  assert.equal(await claimNotification(db, nid, 'owner-notification'), null);
  const parked = await db
    .prepare("SELECT state, last_error FROM order_notifications WHERE order_id = ? AND kind = 'owner-notification'")
    .bind(nid)
    .first();
  assert.equal(parked.state, 'dead');
  assert.match(parked.last_error, /interrupted/);

  // A terminal hold keeps its exact entitlement snapshot and item identity.
  // If the restored unit was resold before a delayed paid event arrives, the
  // paid order still lands once and records a resolvable inventory exception.
  await db.prepare(
    `INSERT INTO products (public_id, name, slug, description, price_cents, currency, stock, active)
     VALUES ('prod_late123456', 'Late digital', 'late-digital', '', 700, 'usd', 1, 1)`,
  ).run();
  const lateProduct = await db.prepare("SELECT id FROM products WHERE slug = 'late-digital'").first();
  const latePublicId = crypto.randomUUID();
  const lateItem = {
    productId: lateProduct.id,
    name: 'Late digital',
    priceCents: 700,
    quantity: 1,
    fileKey: 'deliverables/file-a.pdf',
    fileName: 'file-a.pdf',
    fileMime: 'application/pdf',
    fileSizeBytes: 123,
  };
  assert.equal(await reserveInventory(db, latePublicId, [lateItem], 600, 'lightning'), true);
  const beforeTerminal = await getSettlementReservation(db, latePublicId);
  assert.ok(beforeTerminal?.items[0].publicId?.startsWith('itm_'));
  await db
    .prepare("UPDATE checkout_reservations SET expires_at = datetime('now', '-1 minute') WHERE public_id = ?")
    .bind(latePublicId)
    .run();
  await releaseExpiredReservations(db);
  await db.prepare('UPDATE products SET stock = 0 WHERE id = ?').bind(lateProduct.id).run();
  const terminal = await getSettlementReservation(db, latePublicId);
  assert.equal(terminal?.status, 'expired');
  const lateOrder = {
    providerSessionId: 'late-paid-session',
    publicId: latePublicId,
    reservationId: latePublicId,
    reservationStatus: 'expired',
    email: 'late@example.com',
    amountTotalCents: 700,
    currency: 'usd',
    items: terminal.items,
  };
  assert(await recordPaidOrder(db, lateOrder));
  assert.equal(await recordPaidOrder(db, lateOrder), null, 'redelivery is idempotent');
  const lateSaved = await db
    .prepare("SELECT public_id, file_key, file_name FROM order_items WHERE order_id = (SELECT id FROM orders WHERE provider_session_id = 'late-paid-session')")
    .first();
  assert.equal(lateSaved.public_id, beforeTerminal.items[0].publicId);
  assert.equal(lateSaved.file_key, 'deliverables/file-a.pdf');
  assert.equal(lateSaved.file_name, 'file-a.pdf');
  const exception = await db
    .prepare("SELECT public_id, requested_qty, consumed_qty, shortfall_qty FROM order_inventory_exceptions WHERE order_id = (SELECT id FROM orders WHERE provider_session_id = 'late-paid-session')")
    .first();
  assert.ok(exception.public_id.startsWith('iexc_'));
  assert.deepEqual(
    [exception.requested_qty, exception.consumed_qty, exception.shortfall_qty],
    [1, 0, 1],
  );

  // ---------------------------------------------------------------------
  // Cross-release rollback safety.
  //
  // The rollout gates are a compile-time constant, so a build pinned at
  // release 4 cannot execute release 1's writers. What it CAN do is meet
  // release 1's readers with data only a later release produces — which is
  // precisely the rollback that loses money if a reader was gated. Readers are
  // release-invariant (pinned structurally in rollout.test.ts), so exercising
  // them here IS exercising the rollback target.
  // ---------------------------------------------------------------------

  // (1) A reservation written by a Release-2 build, settled by a Release-1
  // build. Release 1 never mints itm_ IDs of its own, so the published
  // identity survives only if settlement copies the snapshot's. If it minted a
  // fresh one instead, an agent that already polled `confirming` would see the
  // item's identity change under it at `paid`.
  await db.prepare(
    `INSERT INTO products (public_id, name, slug, description, price_cents, currency, stock, active)
     VALUES ('prod_rollback1234', 'Rollback tee', 'rollback-tee', '', 500, 'usd', 5, 1)`,
  ).run();
  const rollbackProduct = await db.prepare("SELECT id FROM products WHERE slug = 'rollback-tee'").first();
  const r2PublicId = crypto.randomUUID();
  const r2ItemId = 'itm_r2publish01';
  const r2Items = [
    { productId: rollbackProduct.id, name: 'Rollback tee', priceCents: 500, quantity: 1, publicId: r2ItemId },
  ];
  // Exactly what Release 2 leaves behind: the snapshot carries the identity and
  // the registry owns it, both written before provider handoff.
  await db.batch([
    db
      .prepare(
        `INSERT INTO checkout_reservations (public_id, items, payment_method, status, expires_at)
         VALUES (?, ?, 'stripe', 'active', datetime('now', '+30 minutes'))`,
      )
      .bind(r2PublicId, JSON.stringify(r2Items)),
    db
      .prepare('INSERT INTO order_item_ids (public_id, order_public_id) VALUES (?, ?)')
      .bind(r2ItemId, r2PublicId),
    db.prepare('UPDATE products SET stock = stock - 1 WHERE id = ?').bind(rollbackProduct.id),
  ]);

  const r2Snapshot = await getSettlementReservation(db, r2PublicId);
  assert.equal(r2Snapshot.items[0].publicId, r2ItemId, 'the R2 snapshot carries its published identity');

  assert(
    await recordPaidOrder(db, {
      providerSessionId: 'r2-reservation-r1-settlement',
      publicId: r2PublicId,
      reservationId: r2PublicId,
      reservationStatus: r2Snapshot.status,
      email: 'rollback@example.com',
      amountTotalCents: 500,
      currency: 'usd',
      items: r2Snapshot.items,
    }),
  );
  const r2Settled = await db
    .prepare(
      "SELECT public_id FROM order_items WHERE order_id = (SELECT id FROM orders WHERE provider_session_id = 'r2-reservation-r1-settlement')",
    )
    .first();
  assert.equal(r2Settled.public_id, r2ItemId, 'settlement preserved the identity instead of minting a new one');
  const r2Claims = await db
    .prepare('SELECT COUNT(*) AS n FROM order_item_ids WHERE order_public_id = ?')
    .bind(r2PublicId)
    .first();
  assert.equal(r2Claims.n, 1, 'no duplicate claim was minted for an already-claimed identity');
  assert.equal(
    (await db.prepare('SELECT stock FROM products WHERE id = ?').bind(rollbackProduct.id).first()).stock,
    4,
    'an active reservation is not decremented twice at settlement',
  );

  // (2) The status URL Release 2 published is still answerable by Release 1.
  // This is the snapshot the route serializes; a 404 here is what a polling
  // agent would read as "unknown or revoked" — permanent loss — rather than a
  // temporary rollback.
  const r2StatusPublicId = crypto.randomUUID();
  const r2StatusItemId = 'itm_r2status01';
  await db
    .prepare(
      `INSERT INTO checkout_reservations (public_id, items, payment_method, status, expires_at)
       VALUES (?, ?, 'stripe', 'active', datetime('now', '+30 minutes'))`,
    )
    .bind(
      r2StatusPublicId,
      JSON.stringify([
        { productId: rollbackProduct.id, name: 'Rollback tee', priceCents: 500, quantity: 1, publicId: r2StatusItemId },
      ]),
    )
    .run();
  const confirming = await getReservationStatusSnapshot(db, r2StatusPublicId);
  assert.equal(confirming.status, 'active', 'an unsettled R2 checkout still resolves (serialized as confirming)');
  assert.equal(confirming.items[0].publicId, r2StatusItemId, 'and reports the identity it already published');

  await db
    .prepare("UPDATE checkout_reservations SET status = 'expired', terminal_at = datetime('now') WHERE public_id = ?")
    .bind(r2StatusPublicId)
    .run();
  const terminalSnapshot = await getReservationStatusSnapshot(db, r2StatusPublicId);
  assert.equal(terminalSnapshot.status, 'expired', 'a terminal R2 checkout is still readable, not absent');
  assert.equal(terminalSnapshot.items[0].publicId, r2StatusItemId, 'identity is stable across confirming → expired');

  // (3) A file attached under Release 4, bought in a checkout that BEGINS after
  // a rollback to Release 3. The product row survives the rollback and shoppers
  // keep buying, so Release 3 must still write the entitlement into the
  // snapshot — otherwise the paid order records no file_key and the
  // entitlement is destroyed permanently, unrecoverable by rolling forward.
  await db.prepare(
    `INSERT INTO products (public_id, name, slug, description, price_cents, currency, stock, active,
                           file_key, file_name, file_mime, file_size_bytes)
     VALUES ('prod_r4attached01', 'Attached guide', 'attached-guide', '', 900, 'usd', 2, 1,
             'deliverables/attached/guide.pdf', 'guide.pdf', 'application/pdf', 4096)`,
  ).run();
  const attachedProduct = await db.prepare("SELECT id FROM products WHERE slug = 'attached-guide'").first();
  const r3PublicId = crypto.randomUUID();
  // Drive the REAL builder over a file-bearing product row, not a hand-written
  // item: hand-writing the snapshot would pass even if checkout stopped copying
  // the entitlement, gated it at the wrong release, or dropped a field — which
  // is the entire failure this case exists to catch.
  const attachedRow = await db
    .prepare('SELECT * FROM products WHERE id = ?')
    .bind(attachedProduct.id)
    .first();
  const [r3Item] = reservationItems([
    {
      product: attachedRow,
      qty: 1,
      name: 'Attached guide',
      unitPriceCents: 900,
      availableStock: attachedRow.stock,
      variantId: null,
    },
  ]);
  assert.equal(r3Item.fileKey, 'deliverables/attached/guide.pdf', 'the builder copied the entitlement');
  assert.equal(await reserveInventory(db, r3PublicId, [r3Item], 600, 'stripe'), true);
  const r3Snapshot = await getSettlementReservation(db, r3PublicId);
  assert.equal(r3Snapshot.items[0].fileKey, 'deliverables/attached/guide.pdf', 'R3 snapshots the entitlement');

  assert(
    await recordPaidOrder(db, {
      providerSessionId: 'r4-attached-r3-checkout',
      publicId: r3PublicId,
      reservationId: r3PublicId,
      reservationStatus: r3Snapshot.status,
      email: 'attached@example.com',
      amountTotalCents: 900,
      currency: 'usd',
      items: r3Snapshot.items,
    }),
  );
  const r3Settled = await db
    .prepare(
      `SELECT public_id, file_key, file_name, file_mime, file_size_bytes
         FROM order_items
        WHERE order_id = (SELECT id FROM orders WHERE provider_session_id = 'r4-attached-r3-checkout')`,
    )
    .first();
  assert.deepEqual(
    [r3Settled.file_key, r3Settled.file_name, r3Settled.file_mime, r3Settled.file_size_bytes],
    ['deliverables/attached/guide.pdf', 'guide.pdf', 'application/pdf', 4096],
    'the entitlement reached the paid order intact',
  );
  assert.ok(r3Settled.public_id?.startsWith('itm_'), 'and the item is addressable for download');

  // (4) Stock-transition purges must fire in EVERY release, including the
  // compatibility one that writes no identity claims. The decrement results sit
  // at a different batch offset there, and reading the wrong slot fails silently
  // — no error, just a storefront showing "In stock" for a sold-out product
  // until the cache TTL expires. Pass the actual Release 1 boundary: omitting
  // item identities is not equivalent under a Release 4 build, because that
  // build mints them before constructing its claim statements.
  await db.prepare(
    `INSERT INTO products (public_id, name, slug, description, price_cents, currency, stock, active)
     VALUES ('prod_purgeboundary', 'Last one', 'last-one', '', 400, 'usd', 1, 1)`,
  ).run();
  const purgeProduct = await db.prepare("SELECT id FROM products WHERE slug = 'last-one'").first();
  const purged = [];
  assert.equal(
    await reserveInventory(
      db,
      crypto.randomUUID(),
      [{ productId: purgeProduct.id, name: 'Last one', priceCents: 400, quantity: 1 }],
      600,
      'stripe',
      async (publicIds) => {
        purged.push(...publicIds);
      },
      1,
    ),
    true,
  );
  assert.deepEqual(purged, ['prod_purgeboundary'], 'crossing In stock → Sold out purged the product');

  console.log('Reservation integration passed: concurrency + pending + terminal settlement + inventory exception + legacy + cross-release rollback + stock purge offset');
} finally {
  await mf.dispose();
}
