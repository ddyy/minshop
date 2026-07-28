import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import {
  MENU_ITEMS_SQL,
  MENU_CAPS,
  addMenuItem,
  moveMenuItem,
  reorderMenuItems,
  removeMenuItem,
  setMenuItemLabel,
  getMenus,
  visibleItems,
  catalogIsOrphaned,
} from '../src/features/navigation/db.ts';
import {
  targetChoices,
  unavailableReason,
  menuReferencesFor,
  PICKER_LIMIT,
} from '../src/features/navigation/admin.ts';

// Navigation menus against a real D1. The properties under test are the ones a
// mocked database cannot show: that the add guard actually rejects unavailable
// targets and duplicate singletons at the moment of the write, that the read
// ceiling holds even when the table is overfilled behind the guard's back, and
// that the migration's seed reproduces what a store already renders.
//
// Schema is hand-rolled to the production shape, matching test-media.mjs.
// scripts/test-d1-integration.sh remains the sole full-migration gate.

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

/** Schema as it exists BEFORE this migration — the upgrade path's starting point. */
const PRE_MENU_SCHEMA = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL,
                         updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT UNIQUE, name TEXT NOT NULL,
                         slug TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1,
                         image_key TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT UNIQUE, name TEXT NOT NULL,
                           slug TEXT NOT NULL UNIQUE, parent_id INTEGER,
                           created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE pages (id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT UNIQUE, title TEXT NOT NULL,
                      slug TEXT NOT NULL UNIQUE, body_markdown TEXT NOT NULL DEFAULT '',
                      published INTEGER NOT NULL DEFAULT 0,
                      created_at TEXT NOT NULL DEFAULT (datetime('now')),
                      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                      layout TEXT NOT NULL DEFAULT 'standard');
`;

// The real migration text, so the seed under test is the one that ships.
const MIGRATION = readFileSync(new URL('../migrations/0028_nav_menus.sql', import.meta.url), 'utf8');

/**
 * Strip whole-line comments FIRST, then split on ';'.
 *
 * Splitting first and discarding chunks that begin with '--' silently drops every
 * statement preceded by a comment block — which, in this migration, is all of
 * them. The migration has no semicolons or '--' inside string literals.
 */
const statements = (sql) =>
  sql
    .split('\n')
    .map((line) => line.replace(/^\s*--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

async function freshDb({ seedBefore } = {}) {
  const db = await mf.getD1Database('DB');
  for (const t of ['menu_items', 'pages', 'categories', 'products', 'settings']) {
    await db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  await db.exec(PRE_MENU_SCHEMA.replace(/\n\s*/g, ' ').trim());
  // Populate BEFORE the migration runs. A clean top-to-bottom migration run
  // creates menu_items while pages/settings are still empty, so the backfill
  // matches zero rows and passes while proving nothing about the upgrade path.
  if (seedBefore) await seedBefore(db);
  for (const stmt of statements(MIGRATION)) await db.exec(stmt.replace(/\n\s*/g, ' '));
  // 0033 adds public_id after 0028; the creation path writes it, so mirror it.
  await db.exec('ALTER TABLE menu_items ADD COLUMN public_id TEXT');
  return db;
}

const addPage = (db, title, slug, published = 1) =>
  db.prepare('INSERT INTO pages (title, slug, published) VALUES (?, ?, ?)').bind(title, slug, published).run();
const addProduct = (db, name, slug, active = 1) =>
  db.prepare('INSERT INTO products (name, slug, active) VALUES (?, ?, ?)').bind(name, slug, active).run();
const addCategory = (db, name, slug) =>
  db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').bind(name, slug).run();
const rowsOf = async (db, sql) => (await db.prepare(sql).all()).results ?? [];

console.log('\nnavigation menus');

// ── migration seed ──────────────────────────────────────────────────────────

await check('seed reproduces the existing footer links, in the footer order', async () => {
  const db = await freshDb({
    seedBefore: async (d) => {
      await addPage(d, 'Shipping', 'shipping');
      await addPage(d, 'about', 'about'); // lowercase: proves COLLATE NOCASE ordering
      await addPage(d, 'Draft', 'draft', 0);
    },
  });
  const items = await rowsOf(db, "SELECT target_id, position FROM menu_items WHERE location='footer' ORDER BY position");
  const titles = await rowsOf(
    db,
    `SELECT p.title FROM menu_items m JOIN pages p ON p.id = m.target_id
      WHERE m.location='footer' ORDER BY m.position`,
  );
  assert.deepEqual(titles.map((t) => t.title), ['about', 'Shipping'], 'NOCASE title order');
  assert.deepEqual(items.map((i) => i.position), [0, 1], 'positions are 0-based and dense');
});

await check('seed adds the header Catalog item only when the home page is overridden', async () => {
  const plain = await freshDb({ seedBefore: async (d) => addPage(d, 'About', 'about') });
  assert.equal((await rowsOf(plain, "SELECT * FROM menu_items WHERE location='header'")).length, 0);

  const overridden = await freshDb({
    seedBefore: async (d) => {
      await addPage(d, 'About', 'about');
      await d.prepare("INSERT INTO settings (key, value) VALUES ('home_page', 'page:1')").run();
    },
  });
  const header = await rowsOf(overridden, "SELECT target_type, label FROM menu_items WHERE location='header'");
  assert.equal(header.length, 1);
  assert.equal(header[0].target_type, 'catalog');
  assert.equal(header[0].label, 'Shop', 'label pinned so a default change cannot rename it');
});

await check('seed is lossless up to the footer cap and deterministic beyond it', async () => {
  const db = await freshDb({
    seedBefore: async (d) => {
      for (let i = 1; i <= 60; i++) {
        await addPage(d, `Page ${String(i).padStart(2, '0')}`, `page-${i}`);
      }
    },
  });
  const seeded = await rowsOf(db, "SELECT COUNT(*) AS c FROM menu_items WHERE location='footer'");
  assert.equal(seeded[0].c, MENU_CAPS.footer, 'seeds up to the footer cap, not the header cap');
  // Deterministic subset: without the outer ORDER BY the LIMIT could keep any 50.
  const first = await rowsOf(
    db,
    `SELECT p.title FROM menu_items m JOIN pages p ON p.id=m.target_id
      WHERE m.location='footer' ORDER BY m.position LIMIT 1`,
  );
  assert.equal(first[0].title, 'Page 01');
});

// ── constraints (SQLite behaviour, so it belongs here and not in vitest) ────

await check('CHECK rejects a singleton with a target, and an object without one', async () => {
  const db = await freshDb();
  await assert.rejects(
    db.prepare("INSERT INTO menu_items (location, target_type, target_id) VALUES ('header','home',5)").run(),
  );
  await assert.rejects(
    db.prepare("INSERT INTO menu_items (location, target_type, target_id) VALUES ('header','page',NULL)").run(),
  );
  await assert.rejects(
    db.prepare("INSERT INTO menu_items (location, target_type) VALUES ('sidebar','home')").run(),
  );
});

await check('partial unique index allows duplicates only where it should', async () => {
  const db = await freshDb({ seedBefore: async (d) => { await addPage(d, 'A', 'a'); await addPage(d, 'B', 'b'); } });
  await db.prepare("INSERT INTO menu_items (location, target_type) VALUES ('header','home')").run();
  await assert.rejects(
    db.prepare("INSERT INTO menu_items (location, target_type) VALUES ('header','home')").run(),
    /UNIQUE/,
    'a second Home in one menu',
  );
  // Same singleton in the OTHER menu is fine, and two page items are fine.
  await db.prepare("INSERT INTO menu_items (location, target_type) VALUES ('footer','home')").run();
  await db.prepare("INSERT INTO menu_items (location, target_type, target_id) VALUES ('header','page',1)").run();
  await db.prepare("INSERT INTO menu_items (location, target_type, target_id) VALUES ('header','page',2)").run();
});

// ── the read ceiling ────────────────────────────────────────────────────────

await check('the query caps each location even when the table is overfilled', async () => {
  const db = await freshDb({ seedBefore: async (d) => addPage(d, 'A', 'a') });
  await db.exec('DELETE FROM menu_items');
  // Straight past the add guard, the way a bad migration or direct write would.
  for (let i = 0; i < 60; i++) {
    await db.prepare("INSERT INTO menu_items (location, target_type, target_id, position) VALUES ('header','page',1,?)").bind(i).run();
  }
  const rows = (await db.prepare(MENU_ITEMS_SQL).all()).results ?? [];
  assert.equal(rows.length, MENU_CAPS.header, 'read ceiling holds independently of the write guard');
});

// ── add guard ───────────────────────────────────────────────────────────────

const seededStore = async () =>
  freshDb({
    seedBefore: async (d) => {
      await addPage(d, 'About', 'about');
      await addPage(d, 'Secret', 'secret', 0);
      await addProduct(d, 'Beanie', 'beanie');
      await addProduct(d, 'Retired', 'retired', 0);
      await addCategory(d, 'Hats', 'hats');
    },
  });

await check('add refuses a draft page, an inactive product, and a missing target', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  assert.equal((await addMenuItem(db, { location: 'header', targetType: 'page', targetId: 2, label: null })).reason, 'unavailable');
  assert.equal((await addMenuItem(db, { location: 'header', targetType: 'product', targetId: 2, label: null })).reason, 'unavailable');
  assert.equal((await addMenuItem(db, { location: 'header', targetType: 'category', targetId: 999, label: null })).reason, 'unavailable');
  assert.equal((await rowsOf(db, 'SELECT * FROM menu_items')).length, 0, 'nothing was written');
});

await check('add accepts available targets and assigns dense positions', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  for (const t of [
    { targetType: 'page', targetId: 1 },
    { targetType: 'product', targetId: 1 },
    { targetType: 'category', targetId: 1 },
  ]) {
    assert.equal((await addMenuItem(db, { location: 'header', label: null, ...t })).ok, true);
  }
  const rows = await rowsOf(db, "SELECT position FROM menu_items WHERE location='header' ORDER BY position");
  assert.deepEqual(rows.map((r) => r.position), [0, 1, 2]);
});

await check('add reports a full menu without writing', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  for (let i = 0; i < MENU_CAPS.header; i++) {
    assert.equal((await addMenuItem(db, { location: 'header', targetType: 'page', targetId: 1, label: null })).ok, true);
  }
  const result = await addMenuItem(db, { location: 'header', targetType: 'page', targetId: 1, label: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'full');
  assert.equal((await rowsOf(db, "SELECT * FROM menu_items WHERE location='header'")).length, MENU_CAPS.header);
});

// Through the service, not by hammering the index directly: the index rejecting a
// raw duplicate proves the backstop works, not that the merchant ever sees a
// sentence instead of a 500.
await check('a duplicate singleton comes back as a reason, not an exception', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  assert.equal((await addMenuItem(db, { location: 'header', targetType: 'home', targetId: null, label: null })).ok, true);
  const second = await addMenuItem(db, { location: 'header', targetType: 'home', targetId: null, label: null });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'duplicate');
  // The same singleton in the other menu is still allowed.
  assert.equal((await addMenuItem(db, { location: 'footer', targetType: 'home', targetId: null, label: null })).ok, true);
});

await check('concurrent adds get distinct positions', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  await Promise.all(
    [1, 1, 1].map(() => addMenuItem(db, { location: 'footer', targetType: 'page', targetId: 1, label: null })),
  );
  const rows = await rowsOf(db, "SELECT position FROM menu_items WHERE location='footer' ORDER BY position");
  assert.equal(new Set(rows.map((r) => r.position)).size, rows.length, 'no two items share a position');
});

// ── resolution and storefront visibility ────────────────────────────────────

await check('unavailable targets vanish from the storefront but stay listed for admin', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  await addMenuItem(db, { location: 'footer', targetType: 'page', targetId: 1, label: null });
  await addMenuItem(db, { location: 'footer', targetType: 'product', targetId: 1, label: null });
  await addMenuItem(db, { location: 'footer', targetType: 'category', targetId: 1, label: null });

  // Each becomes unavailable by its own mechanism.
  await db.prepare('UPDATE pages SET published = 0 WHERE id = 1').run();
  await db.prepare('UPDATE products SET active = 0 WHERE id = 1').run();
  await db.prepare('DELETE FROM categories WHERE id = 1').run();

  const menus = await getMenus(db, null);
  assert.equal(menus.footer.length, 3, 'admin still sees every item');
  assert.equal(visibleItems(menus.footer).length, 0, 'storefront renders none of them');
  assert.deepEqual(
    menus.footer.map((i) => unavailableReason(i)),
    ['Draft — hidden on the storefront', 'Inactive — hidden on the storefront', 'Target no longer exists'],
  );
});

await check('catalog href follows the home page setting', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  await addMenuItem(db, { location: 'header', targetType: 'catalog', targetId: null, label: null });
  assert.equal((await getMenus(db, null)).header[0].href, '/');
  assert.equal((await getMenus(db, 'page:1')).header[0].href, '/products');
});

await check('label override wins, clearing it restores the target name', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  const added = await addMenuItem(db, { location: 'header', targetType: 'page', targetId: 1, label: 'Our story' });
  assert.equal((await getMenus(db, null)).header[0].text, 'Our story');
  await setMenuItemLabel(db, added.id, null);
  assert.equal((await getMenus(db, null)).header[0].text, 'About');
});

// ── reordering ──────────────────────────────────────────────────────────────

await check('move swaps with the neighbour and is a no-op at the ends', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  const a = await addMenuItem(db, { location: 'header', targetType: 'page', targetId: 1, label: 'A' });
  const b = await addMenuItem(db, { location: 'header', targetType: 'page', targetId: 1, label: 'B' });
  const c = await addMenuItem(db, { location: 'header', targetType: 'page', targetId: 1, label: 'C' });

  await moveMenuItem(db, c.id, 'up');
  assert.deepEqual((await getMenus(db, null)).header.map((i) => i.text), ['A', 'C', 'B']);
  await moveMenuItem(db, a.id, 'up'); // already first
  assert.deepEqual((await getMenus(db, null)).header.map((i) => i.text), ['A', 'C', 'B']);
  await moveMenuItem(db, b.id, 'down'); // already last
  assert.deepEqual((await getMenus(db, null)).header.map((i) => i.text), ['A', 'C', 'B']);

  await removeMenuItem(db, c.id);
  assert.deepEqual((await getMenus(db, null)).header.map((i) => i.text), ['A', 'B']);
});

await check('a menu never crosses into the other when reordering', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  const h = await addMenuItem(db, { location: 'header', targetType: 'page', targetId: 1, label: 'H' });
  await addMenuItem(db, { location: 'footer', targetType: 'page', targetId: 1, label: 'F' });
  await moveMenuItem(db, h.id, 'down'); // no neighbour in the header
  const menus = await getMenus(db, null);
  assert.deepEqual(menus.header.map((i) => i.text), ['H']);
  assert.deepEqual(menus.footer.map((i) => i.text), ['F']);
});

// ── admin picker ────────────────────────────────────────────────────────────

await check('picker offers only available targets, bounded and searchable', async () => {
  const db = await seededStore();
  const pages = await targetChoices(db, 'page', '');
  assert.deepEqual(pages.options.map((o) => o.name), ['About'], 'draft page not offered');

  const products = await targetChoices(db, 'product', '');
  assert.deepEqual(products.options.map((o) => o.name), ['Beanie'], 'inactive product not offered');

  const hit = await targetChoices(db, 'product', 'bean');
  assert.equal(hit.options.length, 1);
  const miss = await targetChoices(db, 'product', 'zzz');
  assert.equal(miss.options.length, 0);
});

await check('picker reports how many matches it did not show', async () => {
  const db = await freshDb({
    seedBefore: async (d) => {
      for (let i = 1; i <= 60; i++) await addProduct(d, `Item ${String(i).padStart(2, '0')}`, `i-${i}`);
    },
  });
  const choices = await targetChoices(db, 'product', '');
  assert.equal(choices.options.length, PICKER_LIMIT, 'bounded');
  assert.equal(choices.remaining, 60 - PICKER_LIMIT, 'and honest about the remainder');
  assert.equal(choices.options[0].name, 'Item 01', 'alphabetical, not insertion order');
});

// ── the catalog-orphan warning ──────────────────────────────────────────────

await check('catalogIsOrphaned fires only when the shop is actually unreachable', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');

  assert.equal(await catalogIsOrphaned(db, null), false, '/ IS the catalog: nothing to warn about');
  assert.equal(await catalogIsOrphaned(db, 'page:1'), true, 'overridden with no catalog link');

  await addMenuItem(db, { location: 'footer', targetType: 'catalog', targetId: null, label: null });
  assert.equal(await catalogIsOrphaned(db, 'page:1'), false, 'a link in EITHER menu clears it');
});

// ── review fixes ────────────────────────────────────────────────────────────

await check('a deleted target with a custom label is reported as deleted, not draft', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  // Custom labels outlive their targets, so an empty rendered label cannot be
  // used to detect deletion — that mistake reported deleted pages as drafts and
  // sent the merchant off to un-draft something that no longer exists.
  await addMenuItem(db, { location: 'footer', targetType: 'page', targetId: 1, label: 'Company' });
  await addMenuItem(db, { location: 'footer', targetType: 'product', targetId: 1, label: 'Our Pick' });
  await db.prepare('DELETE FROM pages WHERE id = 1').run();
  await db.prepare('DELETE FROM products WHERE id = 1').run();

  const menus = await getMenus(db, null);
  assert.equal(menus.footer[0].text, 'Company', 'label survives the delete');
  assert.equal(menus.footer[0].targetExists, false);
  assert.deepEqual(
    menus.footer.map((i) => unavailableReason(i)),
    ['Target no longer exists', 'Target no longer exists'],
  );
  assert.equal(visibleItems(menus.footer).length, 0, 'still hidden on the storefront');
});

await check('a draft target keeps its draft reason (not confused with deletion)', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  await addMenuItem(db, { location: 'footer', targetType: 'page', targetId: 1, label: 'Company' });
  await db.prepare('UPDATE pages SET published = 0 WHERE id = 1').run();
  const item = (await getMenus(db, null)).footer[0];
  assert.equal(item.targetExists, true, 'the row is still there');
  assert.equal(unavailableReason(item), 'Draft — hidden on the storefront');
});

await check('a stale home-page setting does not raise a false catalog warning', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  await db.prepare("INSERT INTO settings (key, value) VALUES ('home_page', 'page:1')").run();
  assert.equal(await catalogIsOrphaned(db, 'page:1'), true, 'live override, no catalog link');

  // The chosen page is unpublished: the storefront has already fallen back to
  // the catalog at '/', so the shop is reachable and the warning must go quiet.
  // Otherwise admin says the home page IS the product list and, at the same
  // time, that shoppers cannot reach the product list.
  await db.prepare('UPDATE pages SET published = 0 WHERE id = 1').run();
  assert.equal(await catalogIsOrphaned(db, 'page:1'), false);
});

await check('menu references are reported per target for the delete warning', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  await addMenuItem(db, { location: 'header', targetType: 'page', targetId: 1, label: null });
  await addMenuItem(db, { location: 'footer', targetType: 'page', targetId: 1, label: null });
  await addMenuItem(db, { location: 'footer', targetType: 'category', targetId: 1, label: null });

  const pageRefs = await menuReferencesFor(db, 'page', [1, 2]);
  assert.deepEqual([...(pageRefs.get(1) ?? [])].sort(), ['footer', 'header']);
  assert.equal(pageRefs.has(2), false, 'unreferenced target is absent');

  const catRefs = await menuReferencesFor(db, 'category', [1]);
  assert.deepEqual(catRefs.get(1), ['footer']);
  assert.equal((await menuReferencesFor(db, 'product', [])).size, 0, 'empty ids: no query needed');
});

await check('reorder sets the whole order from an id list', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  const ids = [];
  for (const label of ['A', 'B', 'C', 'D']) {
    ids.push((await addMenuItem(db, { location: 'footer', targetType: 'page', targetId: 1, label })).id);
  }
  const [a, b, c, d] = ids;
  await reorderMenuItems(db, 'footer', [d, b, a, c]);
  assert.deepEqual((await getMenus(db, null)).footer.map((i) => i.text), ['D', 'B', 'A', 'C']);
});

// A partial list would set position 0 on one row while an omitted row keeps 0,
// leaving the rendered order to the `position, id` tie-breaker — an order the
// merchant never chose. Same for duplicates.
await check('reorder rejects incomplete, padded, and duplicate id lists', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  const ids = [];
  for (const label of ['A', 'B', 'C']) {
    ids.push((await addMenuItem(db, { location: 'footer', targetType: 'page', targetId: 1, label })).id);
  }
  const [a, b, c] = ids;
  const order = async () => (await getMenus(db, null)).footer.map((i) => i.text);
  const before = await order();

  assert.equal(await reorderMenuItems(db, 'footer', [c]), false, 'incomplete');
  assert.equal(await reorderMenuItems(db, 'footer', [c, b]), false, 'still incomplete');
  assert.equal(await reorderMenuItems(db, 'footer', [c, b, a, a]), false, 'duplicate');
  assert.equal(await reorderMenuItems(db, 'footer', [c, b, b]), false, 'duplicate, right length');
  assert.equal(await reorderMenuItems(db, 'footer', [c, b, a, 9999]), false, 'padded with a stranger');
  assert.deepEqual(await order(), before, 'nothing was applied');

  // The complete permutation still works.
  assert.equal(await reorderMenuItems(db, 'footer', [c, a, b]), true);
  assert.deepEqual(await order(), ['C', 'A', 'B']);

  // And no two rows share a position afterwards.
  const rows = await rowsOf(db, "SELECT position FROM menu_items WHERE location='footer'");
  assert.equal(new Set(rows.map((r) => r.position)).size, rows.length, 'positions are unique');
});

await check('reorder is scoped to one menu', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  const h1 = (await addMenuItem(db, { location: 'header', targetType: 'page', targetId: 1, label: 'H1' })).id;
  const h2 = (await addMenuItem(db, { location: 'header', targetType: 'page', targetId: 1, label: 'H2' })).id;
  const f1 = (await addMenuItem(db, { location: 'footer', targetType: 'page', targetId: 1, label: 'F1' })).id;

  // A tampered payload naming the footer item must not touch it. Assert the
  // stored POSITION, not just the rendered order: with one footer item the order
  // reads the same either way, so an order-only assertion cannot see the leak.
  const positionOf = async (id) =>
    (await db.prepare('SELECT position FROM menu_items WHERE id = ?').bind(id).first()).position;
  const footerBefore = await positionOf(f1);

  assert.equal(await reorderMenuItems(db, 'header', [h2, h1, f1]), false, 'foreign id rejected');
  await reorderMenuItems(db, 'header', [h2, h1]);
  const menus = await getMenus(db, null);
  assert.deepEqual(menus.header.map((i) => i.text), ['H2', 'H1']);
  assert.equal(await positionOf(f1), footerBefore, 'the other menu is untouched');
});

// 30 is the chunk size, so a full footer spans two statements — the boundary is
// where an off-by-one would silently leave half the menu unordered.
await check('reorder handles a list larger than one chunk', async () => {
  const db = await seededStore();
  await db.exec('DELETE FROM menu_items');
  const ids = [];
  for (let i = 0; i < 35; i++) {
    ids.push((await addMenuItem(db, {
      location: 'footer', targetType: 'page', targetId: 1, label: `Item ${String(i).padStart(2, '0')}`,
    })).id);
  }
  const reversed = [...ids].reverse();
  await reorderMenuItems(db, 'footer', reversed);
  const got = (await getMenus(db, null)).footer.map((i) => i.id);
  assert.deepEqual(got, reversed, 'every item across both chunks is repositioned');
});

console.log(failures === 0 ? '\nmenus: all checks passed\n' : `\nmenus: ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
