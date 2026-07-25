import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import {
  createMediaRecord,
  deleteMediaRecord,
  attachMediaToProduct,
  syncPageMedia,
  listMedia,
  countMedia,
  findMediaByKeys,
} from '../src/features/media/db.ts';
import { mediaUsage, mediaUsageForIds, isUnused } from '../src/features/media/usage.ts';
import { uploadMedia } from '../src/features/media/upload.ts';

// Media lifecycle against a real D1. The properties under test are the ones a
// mocked database cannot show: that the guarded DELETE and the guarded
// association INSERTs actually serialize against each other, and that bulk
// usage agrees with the delete guard about what "in use" means.
//
// Schema is hand-rolled to the production shape, matching test-refunds.mjs and
// test-reservations.mjs. scripts/test-d1-integration.sh remains the sole
// full-migration gate, so schema drift is caught in exactly one place.

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

/** In-memory StorageProvider with injectable failures. */
function fakeStorage({ failPut = false, failDelete = false } = {}) {
  const objects = new Map();
  const deleted = [];
  return {
    objects,
    deleted,
    async put(key, data, contentType) {
      if (failPut) throw new Error('storage put failed');
      objects.set(key, { data, contentType });
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      deleted.push(key);
      if (failDelete) throw new Error('storage delete failed');
      objects.delete(key);
    },
  };
}

const png = (name = 'photo.png') =>
  new File([new Uint8Array(8)], name, { type: 'image/png' });

try {
  const db = await mf.getD1Database('DB');

  for (const sql of [
    `CREATE TABLE media (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       image_key TEXT NOT NULL UNIQUE,
       original_name TEXT NOT NULL,
       mime_type TEXT,
       size_bytes INTEGER,
       created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE products (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       image_key TEXT)`,
    `CREATE TABLE product_images (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       product_id INTEGER NOT NULL,
       image_key TEXT NOT NULL,
       position INTEGER NOT NULL DEFAULT 0,
       alt TEXT)`,
    `CREATE TABLE pages (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       title TEXT NOT NULL,
       slug TEXT NOT NULL UNIQUE,
       published INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE page_media (
       page_id INTEGER NOT NULL,
       media_id INTEGER NOT NULL,
       PRIMARY KEY (page_id, media_id))`,
    `CREATE TABLE settings (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  ]) {
    await db.prepare(sql).run();
  }

  const newMedia = async (key, name = key) =>
    createMediaRecord(db, {
      image_key: key,
      original_name: name,
      mime_type: 'image/png',
      size_bytes: 10,
    });

  console.log('\nexisting-image backfill (migration 0026)');

  await check('adopts gallery AND primary keys, collapsing duplicates', async () => {
    // Pre-0026 shape: images referenced by products only, no media rows yet.
    await db.prepare("INSERT INTO products (id, name, image_key) VALUES (800, 'Legacy A', 'products/a.jpg')").run();
    await db.prepare("INSERT INTO products (id, name, image_key) VALUES (801, 'Legacy B', 'products/only-primary.jpg')").run();
    await db.prepare("INSERT INTO product_images (product_id, image_key, position) VALUES (800, 'products/a.jpg', 0)").run();
    await db.prepare("INSERT INTO product_images (product_id, image_key, position) VALUES (800, 'products/gallery-only.jpg', 1)").run();
    // A duplicate gallery row for a key the primary also holds.
    await db.prepare("INSERT INTO product_images (product_id, image_key, position) VALUES (800, 'products/a.jpg', 2)").run();

    // The exact statements from migrations/0026_pages_media.sql.
    await db
      .prepare(
        `INSERT OR IGNORE INTO media (image_key, original_name)
         SELECT DISTINCT image_key, image_key FROM product_images
          WHERE image_key IS NOT NULL AND image_key != ''`,
      )
      .run();
    await db
      .prepare(
        `INSERT OR IGNORE INTO media (image_key, original_name)
         SELECT DISTINCT image_key, image_key FROM products
          WHERE image_key IS NOT NULL AND image_key != ''`,
      )
      .run();

    const adopted = await findMediaByKeys(db, [
      'products/a.jpg',
      'products/gallery-only.jpg',
      'products/only-primary.jpg',
    ]);
    assert.equal(adopted.length, 3, 'a referenced key was not adopted into the library');
    // UNIQUE(image_key) + INSERT OR IGNORE: one row per key despite three refs.
    const dupes = await db
      .prepare("SELECT COUNT(*) c FROM media WHERE image_key = 'products/a.jpg'")
      .first();
    assert.equal(dupes.c, 1, 'duplicate references created duplicate media rows');
    // Legacy rows carry no type/size — the grid must render them without it.
    const legacy = adopted.find((m) => m.image_key === 'products/a.jpg');
    assert.equal(legacy.mime_type, null);
    assert.equal(legacy.size_bytes, null);
    assert.equal(legacy.original_name, 'products/a.jpg', 'original_name should fall back to the key');
  });

  await check('a backfilled image is protected by the delete guard', async () => {
    const m = (await findMediaByKeys(db, ['products/only-primary.jpg']))[0];
    assert.equal(await deleteMediaRecord(db, m.id), null, 'backfilled primary was deletable');
  });

  console.log('\nupload lifecycle');

  await check('successful upload writes the object and creates the row', async () => {
    const storage = fakeStorage();
    const media = await uploadMedia(db, storage, png(), 'holiday.png');
    assert.ok(storage.objects.has(media.image_key), 'object was not written');
    assert.equal(media.original_name, 'holiday.png');
    assert.equal(media.mime_type, 'image/png');
    const found = await findMediaByKeys(db, [media.image_key]);
    assert.equal(found.length, 1, 'media row missing');
  });

  await check('a failing D1 insert deletes the object it just wrote', async () => {
    const storage = fakeStorage();
    const before = await countMedia(db);
    // uploadMedia takes db as a parameter, so the insert failure is injected
    // directly rather than contrived through a key collision.
    const failingDb = {
      prepare() {
        throw new Error('d1 insert failed');
      },
    };
    await assert.rejects(
      () => uploadMedia(failingDb, storage, png(), 'doomed.png'),
      /d1 insert failed/,
    );
    assert.equal(storage.deleted.length, 1, 'compensating delete did not run');
    assert.equal(storage.objects.size, 0, 'the written object was left orphaned');
    assert.equal(await countMedia(db), before, 'a media row survived a failed insert');
  });

  await check('a failing storage write creates no media row', async () => {
    const storage = fakeStorage({ failPut: true });
    const before = await countMedia(db);
    await assert.rejects(() => uploadMedia(db, storage, png(), 'nope.png'), /storage put failed/);
    assert.equal(await countMedia(db), before, 'row created despite storage failure');
  });

  console.log('\nguarded deletion');

  await check('unreferenced media deletes and returns its key', async () => {
    const m = await newMedia('media/free.png');
    assert.equal(await deleteMediaRecord(db, m.id), 'media/free.png');
    assert.equal((await findMediaByKeys(db, ['media/free.png'])).length, 0, 'row survived');
  });

  await check('media used by a product gallery cannot be deleted', async () => {
    const m = await newMedia('media/gallery.png');
    await db.prepare("INSERT INTO products (id, name) VALUES (901, 'Tee')").run();
    await attachMediaToProduct(db, 901, m.id);
    assert.equal(await deleteMediaRecord(db, m.id), null);
  });

  await check('media used only as a product PRIMARY cannot be deleted', async () => {
    const m = await newMedia('media/primary-only.png');
    await db
      .prepare("INSERT INTO products (id, name, image_key) VALUES (902, 'Mug', ?)")
      .bind(m.image_key)
      .run();
    assert.equal(await deleteMediaRecord(db, m.id), null, 'primary-only reference was ignored');
  });

  await check('media used by a page cannot be deleted', async () => {
    const m = await newMedia('media/page.png');
    await db.prepare("INSERT INTO pages (id, title, slug) VALUES (1, 'About', 'about')").run();
    await syncPageMedia(db, 1, [m.id]);
    assert.equal(await deleteMediaRecord(db, m.id), null);
  });

  await check('media used as the logo cannot be deleted', async () => {
    const m = await newMedia('media/logo.png');
    await db
      .prepare("INSERT INTO settings (key, value) VALUES ('logo_image_key', ?)")
      .bind(m.image_key)
      .run();
    assert.equal(await deleteMediaRecord(db, m.id), null);
    await db.prepare("DELETE FROM settings WHERE key = 'logo_image_key'").run();
    assert.equal(await deleteMediaRecord(db, m.id), m.image_key, 'freed media still refused');
  });

  console.log('\nguarded association writes');

  await check('a stale selection cannot attach media that was already deleted', async () => {
    const m = await newMedia('media/vanishing.png');
    await db.prepare("INSERT INTO products (id, name) VALUES (903, 'Cap')").run();
    assert.equal(await deleteMediaRecord(db, m.id), 'media/vanishing.png');
    const result = await attachMediaToProduct(db, 903, m.id);
    assert.equal(result.ok, false);
    assert.match(result.error, /no longer in the media library/);
    const rows = await db
      .prepare('SELECT COUNT(*) c FROM product_images WHERE product_id = 903')
      .first();
    assert.equal(rows.c, 0, 'a dangling gallery row was created');
  });

  await check('the same media cannot be attached to one product twice', async () => {
    const m = await newMedia('media/once.png');
    await db.prepare("INSERT INTO products (id, name) VALUES (904, 'Bag')").run();
    assert.equal((await attachMediaToProduct(db, 904, m.id)).ok, true);
    const second = await attachMediaToProduct(db, 904, m.id);
    assert.equal(second.ok, false);
    assert.match(second.error, /already in this product/);
  });

  await check('attaching appends at the next gallery position', async () => {
    const a = await newMedia('media/pos-a.png');
    const b = await newMedia('media/pos-b.png');
    await db.prepare("INSERT INTO products (id, name) VALUES (905, 'Scarf')").run();
    await attachMediaToProduct(db, 905, a.id);
    await attachMediaToProduct(db, 905, b.id);
    const rows = await db
      .prepare('SELECT image_key, position FROM product_images WHERE product_id = 905 ORDER BY position')
      .all();
    assert.deepEqual(
      rows.results.map((r) => [r.image_key, r.position]),
      [
        ['media/pos-a.png', 0],
        ['media/pos-b.png', 1],
      ],
    );
  });

  await check('page media sync replaces the previous set', async () => {
    const a = await newMedia('media/sync-a.png');
    const b = await newMedia('media/sync-b.png');
    await db.prepare("INSERT INTO pages (id, title, slug) VALUES (2, 'FAQ', 'faq')").run();
    await syncPageMedia(db, 2, [a.id, b.id]);
    await syncPageMedia(db, 2, [b.id]);
    const rows = await db.prepare('SELECT media_id FROM page_media WHERE page_id = 2').all();
    assert.deepEqual(rows.results.map((r) => r.media_id), [b.id]);
  });

  await check('page media sync skips media deleted concurrently', async () => {
    const gone = await newMedia('media/gone.png');
    await db.prepare("INSERT INTO pages (id, title, slug) VALUES (3, 'Ship', 'ship')").run();
    await deleteMediaRecord(db, gone.id);
    await syncPageMedia(db, 3, [gone.id]);
    const rows = await db.prepare('SELECT COUNT(*) c FROM page_media WHERE page_id = 3').first();
    assert.equal(rows.c, 0, 'a dangling page association was created');
  });

  console.log('\nbulk usage');

  await check('reports a media referenced ONLY through products.image_key as used', async () => {
    const m = await newMedia('media/bulk-primary.png');
    await db
      .prepare("INSERT INTO products (id, name, image_key) VALUES (906, 'Primary Only', ?)")
      .bind(m.image_key)
      .run();
    const usage = await mediaUsage(db, m.id);
    assert.deepEqual(
      usage.products.map((p) => p.name),
      ['Primary Only'],
      'primary-only reference reported as unused — the grid would offer a Delete the guard refuses',
    );
    assert.equal(isUnused(usage), false);
    // The usage view and the delete guard must agree.
    assert.equal(await deleteMediaRecord(db, m.id), null);
  });

  await check('duplicate gallery rows produce ONE product usage entry', async () => {
    const m = await newMedia('media/bulk-dupe.png');
    await db.prepare("INSERT INTO products (id, name) VALUES (907, 'Dup Gallery')").run();
    // Duplicates are permitted on existing databases, so usage must collapse them.
    for (const position of [0, 1]) {
      await db
        .prepare('INSERT INTO product_images (product_id, image_key, position) VALUES (907, ?, ?)')
        .bind(m.image_key, position)
        .run();
    }
    const usage = await mediaUsage(db, m.id);
    assert.equal(usage.products.length, 1, `expected one entry, got ${usage.products.length}`);
    assert.equal(usage.products[0].name, 'Dup Gallery');
  });

  await check('resolves a full 48-item page in a bounded number of statements', async () => {
    const ids = [];
    for (let i = 0; i < 48; i++) ids.push((await newMedia(`media/page-${i}.png`)).id);
    const usage = await mediaUsageForIds(db, ids);
    assert.equal(usage.size, 48, 'every requested id must get an entry');
    for (const id of ids) assert.ok(usage.get(id), `missing entry for ${id}`);
    assert.ok([...usage.values()].every(isUnused), 'fresh media reported as used');
  });

  await check('listMedia paginates newest-first and deterministically', async () => {
    const first = await listMedia(db, 5, 0);
    const second = await listMedia(db, 5, 5);
    assert.equal(first.length, 5);
    const overlap = first.filter((a) => second.some((b) => b.id === a.id));
    assert.equal(overlap.length, 0, 'pages overlapped');
  });
} finally {
  await mf.dispose();
}

if (failures > 0) {
  console.error(`\n${failures} media check(s) failed`);
  process.exit(1);
}
console.log('\nmedia lifecycle: all checks passed');
