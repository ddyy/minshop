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

await mf.dispose();
if (failures > 0) {
  console.error(`\n${failures} shipping D1 check(s) failed`);
  process.exit(1);
}
console.log('\nshipping D1 checks passed');
