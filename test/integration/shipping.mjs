import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import {
  SHIPPING_CONFIG_KEY,
  SHIPPING_SCHEMA_VERSION,
  fingerprintRawConfig,
  parseRuntimeShippingConfig,
  replaceInvalidShippingConfig,
  saveRuntimeShippingConfig,
  serializeRuntimeShippingConfig,
} from '../../src/features/shipping/settings.ts';
import { countProductsMissingWeight } from '../../src/features/shipping/sellability.ts';
import {
  PURCHASE_LEASE_SECONDS,
  claimPurchase,
  markLabelFailed,
  discardLabelAttempt,
  getLabelRecord,
  markLabelUncertain,
  recordPurchased,
  recordQuote,
} from '../../src/features/shipping/labelStore.ts';
import { fulfillOrder } from '../../src/features/orders/db.ts';

// Merchant-managed shipping against a real D1. The properties here are the ones a
// mocked database cannot show: that the revision guard actually serializes two
// concurrent saves, that a malformed row cannot be overwritten by the ordinary
// path, that the fingerprint-guarded replacement refuses to clobber a repair made
// meanwhile, and that the missing-weight count reflects real variant inheritance.
//
// Schema is hand-rolled to the production shape, matching test-menus.mjs.
// test/integration/d1-integration.sh remains the sole full-migration gate.

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  compatibilityDate: '2026-07-20',
  d1Databases: ['DB'],
});

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
};

const SCHEMA = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL,
                         updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
                         active INTEGER NOT NULL DEFAULT 1,
                         weight_grams INTEGER,
                         requires_shipping INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE product_variants (id INTEGER PRIMARY KEY AUTOINCREMENT,
                                 product_id INTEGER NOT NULL, label TEXT NOT NULL,
                                 active INTEGER NOT NULL DEFAULT 1,
                                 weight_grams INTEGER);

  CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT,
                       public_id TEXT UNIQUE, email TEXT,
                       status TEXT NOT NULL DEFAULT 'paid',
                       fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled',
                       tracking_carrier TEXT, tracking_number TEXT,
                       fulfilled_at TEXT, label_url TEXT, delivery_method TEXT);
  CREATE TABLE shipping_labels (order_id INTEGER PRIMARY KEY,
                                status TEXT NOT NULL, shipment_id TEXT NOT NULL,
                                rate_id TEXT, transaction_id TEXT, provider TEXT,
                                service TEXT, amount_cents INTEGER,
                                tracking_number TEXT, label_url TEXT, error TEXT,
                                claim_token TEXT,
                                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                                updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE order_notifications (order_id INTEGER NOT NULL, kind TEXT NOT NULL,
                                    state TEXT NOT NULL DEFAULT 'pending',
                                    attempts INTEGER NOT NULL DEFAULT 0,
                                    lease_expires_at TEXT, last_error TEXT,
                                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                                    sent_at TEXT, PRIMARY KEY (order_id, kind));
`;

const zone = (name = 'United States', amountCents = 600) => ({
  name,
  countries: ['US'],
  rates: [{ label: 'Standard', pricing: { type: 'flat', amountCents } }],
  freeOverCents: null,
});

const document = (overrides = {}) => ({ enabled: true, packageWeightGrams: 0, zones: [zone()], ...overrides });

async function freshDb() {
  const db = await mf.getD1Database('DB');
  await db.exec('DROP TABLE IF EXISTS settings');
  await db.exec('DROP TABLE IF EXISTS products');
  await db.exec('DROP TABLE IF EXISTS product_variants');
  await db.exec('DROP TABLE IF EXISTS orders');
  await db.exec('DROP TABLE IF EXISTS shipping_labels');
  await db.exec('DROP TABLE IF EXISTS order_notifications');
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.exec(stmt.replace(/\s+/g, ' '));
  }
  return db;
}

const readRaw = async (db) =>
  (await db.prepare('SELECT value FROM settings WHERE key = ?').bind(SHIPPING_CONFIG_KEY).first())
    ?.value ?? null;

console.log('shipping (D1)');

await check('first save creates revision 1', async () => {
  const db = await freshDb();
  const result = await saveRuntimeShippingConfig(db, 0, document());
  assert.equal(result.ok, true);
  assert.equal(result.config.revision, 1);
  assert.equal(result.config.schema, SHIPPING_SCHEMA_VERSION);
});

await check('an edit at the current revision succeeds and increments it', async () => {
  const db = await freshDb();
  await saveRuntimeShippingConfig(db, 0, document());
  const second = await saveRuntimeShippingConfig(db, 1, document({ zones: [zone('US', 700)] }));
  assert.equal(second.ok, true);
  assert.equal(second.config.revision, 2);
});

await check('two writes from the same revision: exactly one wins', async () => {
  const db = await freshDb();
  await saveRuntimeShippingConfig(db, 0, document());
  const [a, b] = await Promise.all([
    saveRuntimeShippingConfig(db, 1, document({ zones: [zone('A', 111)] })),
    saveRuntimeShippingConfig(db, 1, document({ zones: [zone('B', 222)] })),
  ]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1, 'exactly one save should win');
  const stored = parseRuntimeShippingConfig(await readRaw(db));
  assert.equal(stored.status, 'valid');
  assert.equal(stored.config.revision, 2);
});

await check('a stale write returns conflict and changes nothing', async () => {
  const db = await freshDb();
  await saveRuntimeShippingConfig(db, 0, document());
  await saveRuntimeShippingConfig(db, 1, document({ zones: [zone('Current', 900)] }));
  const before = await readRaw(db);
  const stale = await saveRuntimeShippingConfig(db, 1, document({ zones: [zone('Stale', 100)] }));
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'conflict');
  assert.equal(await readRaw(db), before, 'the stored document must be untouched');
});

await check('invalid existing JSON cannot be overwritten by the ordinary save path', async () => {
  const db = await freshDb();
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(SHIPPING_CONFIG_KEY, '{ broken').run();
  const result = await saveRuntimeShippingConfig(db, 0, document());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'conflict');
  assert.equal(await readRaw(db), '{ broken');
});

await check('replace succeeds when the guarded raw value is unchanged', async () => {
  const db = await freshDb();
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(SHIPPING_CONFIG_KEY, '{ broken').run();
  const fingerprint = await fingerprintRawConfig('{ broken');
  const result = await replaceInvalidShippingConfig(db, fingerprint, document());
  assert.equal(result.ok, true);
  assert.equal(parseRuntimeShippingConfig(await readRaw(db)).status, 'valid');
});

await check('replace returns conflict when another tab repaired it first', async () => {
  const db = await freshDb();
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(SHIPPING_CONFIG_KEY, '{ broken').run();
  // The merchant loaded the page against the broken value…
  const staleFingerprint = await fingerprintRawConfig('{ broken');
  // …and another tab repaired it before they pressed the button.
  const repaired = serializeRuntimeShippingConfig({
    schema: SHIPPING_SCHEMA_VERSION,
    revision: 1,
    ...document({ zones: [zone('Repaired', 800)] }),
  });
  await db.prepare('UPDATE settings SET value = ? WHERE key = ?').bind(repaired, SHIPPING_CONFIG_KEY).run();

  const result = await replaceInvalidShippingConfig(db, staleFingerprint, document());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'conflict');
  assert.equal(await readRaw(db), repaired, 'the repair must survive');
});

await check('a failed save leaves the complete previous document intact', async () => {
  const db = await freshDb();
  await saveRuntimeShippingConfig(db, 0, document({ zones: [zone('Keep me', 555)] }));
  const before = await readRaw(db);
  const invalid = await saveRuntimeShippingConfig(db, 1, document({ zones: [{ ...zone(), countries: [] }] }));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid');
  assert.equal(await readRaw(db), before);
});

await check('missing-weight count honours variant inheritance', async () => {
  const db = await freshDb();
  const addProduct = (id, weight, requires = 1, active = 1) =>
    db
      .prepare('INSERT INTO products (id, name, active, weight_grams, requires_shipping) VALUES (?, ?, ?, ?, ?)')
      .bind(id, `P${id}`, active, weight, requires)
      .run();
  const addVariant = (productId, weight, active = 1) =>
    db
      .prepare('INSERT INTO product_variants (product_id, label, active, weight_grams) VALUES (?, ?, ?, ?)')
      .bind(productId, 'S', active, weight)
      .run();

  await addProduct(1, 250); // fine: has its own weight
  await addProduct(2, null); // missing
  await addProduct(3, null, 0); // digital — never blocks
  await addProduct(4, null, 1, 0); // inactive draft — not a blocked sale
  await addProduct(5, 250);
  await addVariant(5, null); // inherits 250 → fine
  await addProduct(6, null);
  await addVariant(6, 400); // own weight → fine
  await addProduct(7, null);
  await addVariant(7, null); // inherits null → missing
  await addProduct(8, null);
  await addVariant(8, 400, 0); // inactive variant, product weight null → missing

  assert.equal(await countProductsMissingWeight(db), 3, 'products 2, 7 and 8 need a weight');
});

// ── Label purchase state machine ────────────────────────────────────────────
// The claims that keep a money-moving purchase single: only a real D1 can show
// two concurrent submits racing the conditional UPDATE.

console.log('\nshipping labels (D1)');

const addOrder = async (db, id, over = {}) => {
  await db
    .prepare(
      `INSERT INTO orders (id, public_id, status, fulfillment_status, delivery_method)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, `ord_label_${id}`, over.status ?? 'paid', over.fulfillment ?? 'unfulfilled', 'delivery' in over ? over.delivery : 'shipping')
    .run();
};

await check('quoting requires a paid, unfulfilled delivery order', async () => {
  const db = await freshDb();
  await addOrder(db, 1);
  await addOrder(db, 2, { status: 'refunded' });
  await addOrder(db, 3, { fulfillment: 'fulfilled' });
  await addOrder(db, 4, { delivery: 'pickup' });
  assert.equal(await recordQuote(db, 1, 'shp_a'), true);
  assert.equal(await recordQuote(db, 2, 'shp_b'), false, 'refunded order must refuse');
  assert.equal(await recordQuote(db, 3, 'shp_c'), false, 'fulfilled order must refuse');
  assert.equal(await recordQuote(db, 4, 'shp_d'), false, 'pickup order must refuse');
});

await check('unknown and legacy-null delivery modes cannot quote', async () => {
  const db = await freshDb();
  await addOrder(db, 1, { delivery: 'unknown' });
  await addOrder(db, 2, { delivery: null });
  assert.equal(await recordQuote(db, 1, 'shp_a'), false, "'unknown' must be reconciled, not guessed");
  assert.equal(await recordQuote(db, 2, 'shp_b'), false, 'post-0036, NULL means not-a-delivery');
});

await check('a foreign shipment id can never be bought from', async () => {
  const db = await freshDb();
  await addOrder(db, 1);
  await addOrder(db, 2);
  await recordQuote(db, 1, 'shp_mine');
  await recordQuote(db, 2, 'shp_other');
  // The claim returns the ORDER'S OWN shipment — whatever the form said.
  const claim = await claimPurchase(db, 1, 'rate_x');
  assert.equal(claim.shipmentId, 'shp_mine');
  assert.ok(claim.claimToken, 'every claim carries its own token');
});

await check('exactly one concurrent purchase claim wins', async () => {
  const db = await freshDb();
  await addOrder(db, 1);
  await recordQuote(db, 1, 'shp_a');
  const [a, b] = await Promise.all([
    claimPurchase(db, 1, 'rate_1'),
    claimPurchase(db, 1, 'rate_2'),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1, 'one claim exactly');
});

await check('a submitted claim can never be discarded or replaced — at any age', async () => {
  const db = await freshDb();
  await addOrder(db, 1);
  await recordQuote(db, 1, 'shp_a');
  await claimPurchase(db, 1, 'rate_1');
  assert.equal(await discardLabelAttempt(db, 1), false, 'live claim must not discard');
  assert.equal(await recordQuote(db, 1, 'shp_b'), false, 'live claim must not be replaced');
  // Even far past the lease: the request may STILL complete at Shippo, and
  // reopening locally is how two real charges happen. Only provider
  // reconciliation (→ purchased or failed) settles it.
  await db
    .prepare(`UPDATE shipping_labels SET updated_at = datetime('now', '-' || ? || ' seconds') WHERE order_id = 1`)
    .bind(PURCHASE_LEASE_SECONDS * 10)
    .run();
  assert.equal(await discardLabelAttempt(db, 1), false, 'stale claim still must not discard');
  assert.equal(await recordQuote(db, 1, 'shp_b'), false, 'stale claim still must not be replaced');
  assert.equal(await claimPurchase(db, 1, 'rate_2'), null, 'no second claim while unsettled');
});

await check('manual fulfillment loses to an in-flight purchase, and vice versa', async () => {
  const db = await freshDb();
  await addOrder(db, 1);
  await recordQuote(db, 1, 'shp_a');
  await claimPurchase(db, 1, 'rate_1');
  // The claim is live: the manual path must refuse rather than race the charge.
  assert.equal(await fulfillOrder(db, 1, 'usps', 'MANUAL-1'), false);
  const order = await db.prepare('SELECT fulfillment_status FROM orders WHERE id = 1').first();
  assert.equal(order.fulfillment_status, 'unfulfilled');
  // And the mirror: once manually fulfilled (no label row), a claim cannot start.
  await addOrder(db, 2);
  assert.equal(await fulfillOrder(db, 2, 'usps', 'MANUAL-2'), true);
  assert.equal(await recordQuote(db, 2, 'shp_b'), false);
});

await check('a forced fulfillment mid-purchase surfaces as a reconciliation state', async () => {
  const db = await freshDb();
  await addOrder(db, 1);
  await recordQuote(db, 1, 'shp_a');
  const raceClaim = await claimPurchase(db, 1, 'rate_1');
  // Simulate the guard being bypassed (e.g. a pre-guard deploy still running):
  // force-fulfil directly, then let the provider success land.
  await db
    .prepare(`UPDATE orders SET fulfillment_status = 'fulfilled', tracking_number = 'MANUAL-X' WHERE id = 1`)
    .run();
  const result = await recordPurchased(db, 1, raceClaim.claimToken, {
    transactionId: 'txn_race',
    provider: 'USPS',
    service: 'Priority Mail',
    amountCents: 733,
    trackingNumber: '9400race',
    labelUrl: 'https://labels.example/race.pdf',
    carrierCode: 'usps',
  });
  assert.equal(result.recorded, true, 'the paid label is still persisted');
  assert.equal(result.orderFulfilled, false, 'zero-row order update is reported, not swallowed');
  // The shipped email must NOT go out carrying the manual tracking number.
  const note = await db
    .prepare(`SELECT 1 FROM order_notifications WHERE order_id = 1 AND kind = 'order-shipped'`)
    .first();
  assert.equal(note, null, 'no shipped email for a tracking number that did not land');
});

await check('a late completion of a stale submitted claim records durably', async () => {
  const db = await freshDb();
  await addOrder(db, 1);
  await recordQuote(db, 1, 'shp_a');
  const attemptA = await claimPurchase(db, 1, 'rate_a');
  // A outlives its lease. Nothing can supersede it (previous test), so when its
  // provider call finally lands, the success is recorded like any other — the
  // paid label ends up durable in D1, not stranded in a redirect message.
  await db
    .prepare(`UPDATE shipping_labels SET updated_at = datetime('now', '-' || ? || ' seconds') WHERE order_id = 1`)
    .bind(PURCHASE_LEASE_SECONDS * 10)
    .run();
  const late = await recordPurchased(db, 1, attemptA.claimToken, {
    transactionId: 'txn_A',
    provider: 'USPS',
    service: 'Priority Mail',
    amountCents: 733,
    trackingNumber: '9400-A',
    labelUrl: 'https://labels.example/a.pdf',
    carrierCode: 'usps',
  });
  assert.equal(late.recorded, true);
  assert.equal(late.orderFulfilled, true);
  assert.equal((await getLabelRecord(db, 1)).status, 'purchased');
});

await check('reconciliation settles an uncertain attempt either way', async () => {
  const db = await freshDb();
  // Found at Shippo → recorded via the same guarded completion.
  await addOrder(db, 1);
  await recordQuote(db, 1, 'shp_a');
  const a = await claimPurchase(db, 1, 'rate_1');
  await markLabelUncertain(db, 1, a.claimToken, 'network lost');
  const recovered = await recordPurchased(db, 1, a.claimToken, {
    transactionId: 'txn_rec',
    provider: 'USPS',
    service: 'Priority Mail',
    amountCents: 733,
    trackingNumber: '9400rec',
    labelUrl: 'https://labels.example/rec.pdf',
    carrierCode: 'usps',
  });
  assert.equal(recovered.recorded, true, 'an uncertain row accepts its own late success');
  assert.equal(recovered.orderFulfilled, true);
  // Proven no-purchase → failed → the order reopens.
  await addOrder(db, 2);
  await recordQuote(db, 2, 'shp_b');
  const b = await claimPurchase(db, 2, 'rate_2');
  await markLabelUncertain(db, 2, b.claimToken, 'network lost');
  await markLabelFailed(db, 2, b.claimToken, 'Reconciled: no label was purchased.');
  assert.equal((await getLabelRecord(db, 2)).status, 'failed');
  assert.equal(await recordQuote(db, 2, 'shp_c'), true, 'a proven no-purchase reopens quoting');
  // A stale token cannot settle anything (fencing still applies).
  await addOrder(db, 3);
  await recordQuote(db, 3, 'shp_d');
  const c = await claimPurchase(db, 3, 'rate_3');
  await markLabelFailed(db, 3, 'not-the-token', 'spoof');
  assert.equal((await getLabelRecord(db, 3)).status, 'purchasing');
  assert.ok(c.claimToken);
});

await check('a refund during the provider call blocks fulfillment and the email', async () => {
  const db = await freshDb();
  await addOrder(db, 1);
  await recordQuote(db, 1, 'shp_a');
  const claim = await claimPurchase(db, 1, 'rate_1');
  // The order is refunded while Shippo processes the purchase.
  await db.prepare(`UPDATE orders SET status = 'refunded' WHERE id = 1`).run();
  const result = await recordPurchased(db, 1, claim.claimToken, {
    transactionId: 'txn_refund',
    provider: 'USPS',
    service: 'Priority Mail',
    amountCents: 733,
    trackingNumber: '9400refund',
    labelUrl: 'https://labels.example/r.pdf',
    carrierCode: 'usps',
  });
  // The paid label is preserved for reconciliation; the refunded order is not
  // marked shipped and the customer is not told their refund is on its way.
  assert.equal(result.recorded, true);
  assert.equal(result.orderFulfilled, false);
  const order = await db.prepare('SELECT fulfillment_status, tracking_number FROM orders WHERE id = 1').first();
  assert.equal(order.fulfillment_status, 'unfulfilled');
  assert.equal(order.tracking_number, null);
  const note = await db
    .prepare(`SELECT 1 FROM order_notifications WHERE order_id = 1 AND kind = 'order-shipped'`)
    .first();
  assert.equal(note, null, 'no shipped email for a refunded order');
  const row = await getLabelRecord(db, 1);
  assert.equal(row.status, 'purchased', 'label record survives for reconciliation');
});

await check('an uncertain outcome blocks everything except reconciliation', async () => {
  const db = await freshDb();
  await addOrder(db, 1);
  await recordQuote(db, 1, 'shp_a');
  const claim = await claimPurchase(db, 1, 'rate_1');
  await markLabelUncertain(db, 1, claim.claimToken, 'network lost');
  assert.equal(await recordQuote(db, 1, 'shp_b'), false, 'uncertain must refuse a new quote');
  assert.equal(await claimPurchase(db, 1, 'rate_1'), null, 'no second purchase');
  // Discard cannot touch it — the charge may exist. Only reconciliation's
  // proven no-purchase (markLabelFailed with the row's token) reopens it.
  assert.equal(await discardLabelAttempt(db, 1), false, 'uncertain is not discardable');
  await markLabelFailed(db, 1, claim.claimToken, 'Reconciled: no label was purchased.');
  assert.equal(await recordQuote(db, 1, 'shp_b'), true, 'a proven no-purchase reopens the order');
});

await check('recordPurchased lands label, fulfillment, and the shipped email in one batch', async () => {
  const db = await freshDb();
  await addOrder(db, 1);
  await recordQuote(db, 1, 'shp_a');
  const okClaim = await claimPurchase(db, 1, 'rate_1');
  await recordPurchased(db, 1, okClaim.claimToken, {
    transactionId: 'txn_1',
    provider: 'USPS',
    service: 'Priority Mail',
    amountCents: 733,
    trackingNumber: '9400tracking',
    labelUrl: 'https://labels.example/1.pdf',
    carrierCode: 'usps',
  });
  const record = await getLabelRecord(db, 1);
  assert.equal(record.status, 'purchased');
  assert.equal(record.transaction_id, 'txn_1');
  const order = await db.prepare('SELECT * FROM orders WHERE id = 1').first();
  assert.equal(order.fulfillment_status, 'fulfilled');
  assert.equal(order.tracking_number, '9400tracking');
  assert.equal(order.label_url, 'https://labels.example/1.pdf');
  const note = await db
    .prepare(`SELECT state FROM order_notifications WHERE order_id = 1 AND kind = 'order-shipped'`)
    .first();
  assert.ok(note, 'shipped notification queued in the same batch');
  // A purchased row is untouchable: no discard, no requote.
  assert.equal(await discardLabelAttempt(db, 1), false);
  assert.equal(await recordQuote(db, 1, 'shp_new'), false);
});

await mf.dispose();
if (failures > 0) {
  console.error(`\n${failures} shipping D1 check(s) failed`);
  process.exit(1);
}
console.log('\nshipping D1 checks passed');
