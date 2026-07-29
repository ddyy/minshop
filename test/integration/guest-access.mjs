import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import {
  claimOrderIdentity,
  resolveAccessToken,
  getGuestAccess,
  reissueGuestAccess,
  deleteGuestAccessIfUnsettled,
  sweepAbandonedGuestAccess,
  guestOrderUrl,
} from '../../src/features/orders/guestAccess.ts';
import { parsePublicId } from '../../src/features/ids/publicId.ts';
import { isAccessToken } from '../../src/features/ids/token.ts';

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  compatibilityDate: '2026-07-20',
  d1Databases: ['DB'],
});

try {
  const db = await mf.getD1Database('DB');
  // Minimal production-shaped schema for the guest-access state machine. The
  // Wrangler integration gate applies every real migration clean-room.
  for (const sql of [
    `CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT UNIQUE, email TEXT)`,
    `CREATE TABLE order_guest_access (
       order_public_id TEXT NOT NULL PRIMARY KEY,
       access_token    TEXT NOT NULL UNIQUE,
       generation      INTEGER NOT NULL DEFAULT 1,
       created_at      TEXT NOT NULL DEFAULT (datetime('now')),
       rotated_at      TEXT
     )`,
    `CREATE TABLE order_notifications (
       order_id INTEGER NOT NULL, kind TEXT NOT NULL,
       state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
       lease_expires_at TEXT, last_error TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT,
       PRIMARY KEY (order_id, kind))`,
    `CREATE TABLE pending_payments (public_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', expires_at TEXT)`,
    `CREATE TABLE checkout_reservations (public_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active')`,
  ]) {
    await db.exec(sql.replace(/\n\s*/g, ' '));
  }

  // Claim at checkout: BOTH halves minted together; token resolves; bare id never.
  const { publicId: orderPublicId, accessToken: token } = await claimOrderIdentity(db);
  assert.ok(parsePublicId(orderPublicId, 'order'), 'claimed id is a valid ord_');
  assert.ok(isAccessToken(token), 'issued token is canonical');
  const resolved = await resolveAccessToken(db, token);
  assert.equal(resolved?.order_public_id, orderPublicId);
  assert.equal(await resolveAccessToken(db, orderPublicId), null, 'bare ord_ id grants nothing');
  assert.equal(await resolveAccessToken(db, 'otk_invalid'), null);

  // Reissue refuses an UNSETTLED checkout (no orders row yet).
  assert.equal(await reissueGuestAccess(db, orderPublicId), null, 'reissue refused while pending');

  // Settle, then reissue: rotation + notification enqueue land in ONE batch.
  const inserted = await db
    .prepare('INSERT INTO orders (public_id, email) VALUES (?, ?) RETURNING id')
    .bind(orderPublicId, 'c@example.com')
    .first();
  const reissued = await reissueGuestAccess(db, orderPublicId);
  assert.equal(reissued?.generation, 2);
  assert.equal(await resolveAccessToken(db, token), null, 'old token stops resolving');
  const rotated = await getGuestAccess(db, orderPublicId);
  assert.ok(rotated && rotated.access_token !== token && isAccessToken(rotated.access_token));
  const queued = await db
    .prepare('SELECT kind, state FROM order_notifications WHERE order_id = ?')
    .bind(inserted.id)
    .first();
  assert.equal(queued?.kind, 'guest-link-reissue:2', 'notification queued atomically with rotation');
  assert.equal(queued?.state, 'pending');

  // A second reissue queues its own versioned row (no idempotent collision).
  const again = await reissueGuestAccess(db, orderPublicId);
  assert.equal(again?.generation, 3);
  const kinds = (
    await db.prepare('SELECT kind FROM order_notifications WHERE order_id = ? ORDER BY kind').bind(inserted.id).all()
  ).results.map((r) => r.kind);
  assert.deepEqual(kinds, ['guest-link-reissue:2', 'guest-link-reissue:3']);

  // GC guard: a settled order's row is never deleted; an unsettled one is.
  assert.equal(await deleteGuestAccessIfUnsettled(db, orderPublicId), false, 'settled row survives GC');
  const abandoned = await claimOrderIdentity(db);
  assert.equal(await deleteGuestAccessIfUnsettled(db, abandoned.publicId), true, 'abandoned row collected');
  assert.equal(await getGuestAccess(db, abandoned.publicId), null);

  // Reconciliation sweep: a pending payment that expired well past the grace
  // window loses its credential; the settled order's row survives untouched.
  const expired = await claimOrderIdentity(db);
  await db
    .prepare("INSERT INTO pending_payments (public_id, status, expires_at) VALUES (?, 'pending', datetime('now', '-4 days'))")
    .bind(expired.publicId)
    .run();
  const fresh = await claimOrderIdentity(db); // recent row, nothing terminal — must survive
  const removed = await sweepAbandonedGuestAccess(db);
  assert.equal(removed, 1, 'sweep removed exactly the terminally expired row');
  assert.equal(await getGuestAccess(db, expired.publicId), null);
  assert.ok(await getGuestAccess(db, fresh.publicId), 'fresh unsettled row survives the sweep');
  assert.ok(await getGuestAccess(db, orderPublicId), 'settled row survives the sweep');

  // Customer-email guest URLs: tokenized for ord_ orders, legacy passthrough,
  // and null (omit link) when a new order somehow has no registry row.
  const url = await guestOrderUrl(db, orderPublicId, 'https://s.example');
  const current = await getGuestAccess(db, orderPublicId);
  assert.equal(url, `https://s.example/order/${current.access_token}`);
  const legacy = 'ab'.repeat(16);
  assert.equal(await guestOrderUrl(db, legacy, 'https://s.example'), `https://s.example/order/${legacy}`);
  assert.equal(await guestOrderUrl(db, 'ord_zzzzzzzzzz', 'https://s.example'), null);

  console.log('guest-access integration: all assertions passed');
} finally {
  await mf.dispose();
}
