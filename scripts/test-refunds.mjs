import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import {
  recordExternalRefund,
  syncProviderRefund,
  voidRecordedRefund,
  listRefunds,
  reversedRefundIds,
  openRefundReview,
  acknowledgeRefundReview,
} from '../src/features/refunds/db.ts';
import { persistRefundEvent, applyRefundEvent } from '../src/features/refunds/sync.ts';

// Refund accounting against a real D1. The properties under test are the ones
// a mocked database cannot show: that the guarded batches actually serialize,
// that a replay applies nothing, and that the generated aggregate can't drift.

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

try {
  const db = await mf.getD1Database('DB');

  // Post-0025 shape, including the generated aggregate under test.
  for (const sql of [
    `CREATE TABLE orders (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       public_id TEXT UNIQUE,
       provider_session_id TEXT UNIQUE,
       amount_total_cents INTEGER NOT NULL,
       currency TEXT NOT NULL DEFAULT 'usd',
       status TEXT NOT NULL DEFAULT 'pending',
       payment_method TEXT,
       provider_payment_id TEXT,
       provider_refunded_cents INTEGER NOT NULL DEFAULT 0,
       external_refunded_cents INTEGER NOT NULL DEFAULT 0,
       refund_review_reason TEXT,
       refund_reviewed_at TEXT,
       refund_reviewed_by TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       refunded_cents INTEGER GENERATED ALWAYS AS (
         MIN(amount_total_cents, provider_refunded_cents + external_refunded_cents)
       ) VIRTUAL
     )`,
    `CREATE TABLE refunds (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       public_id TEXT NOT NULL UNIQUE,
       order_id INTEGER NOT NULL REFERENCES orders(id),
       kind TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending',
       amount_cents INTEGER NOT NULL,
       provider TEXT,
       provider_refund_id TEXT,
       provider_event_id TEXT,
       reason TEXT,
       note TEXT,
       created_by TEXT,
       idempotency_key TEXT NOT NULL UNIQUE,
       reverses_refund_id INTEGER UNIQUE REFERENCES refunds(id),
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE refund_sync_events (
       provider_event_id TEXT PRIMARY KEY,
       provider TEXT NOT NULL,
       provider_payment_id TEXT,
       provider_charge_id TEXT,
       cumulative_refunded_cents INTEGER NOT NULL,
       currency TEXT,
       status TEXT NOT NULL DEFAULT 'pending',
       attempts INTEGER NOT NULL DEFAULT 0,
       last_error TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       processed_at TEXT
     )`,
    `CREATE UNIQUE INDEX refunds_provider_refund ON refunds (provider, provider_refund_id) WHERE provider_refund_id IS NOT NULL`,
    `CREATE UNIQUE INDEX refunds_provider_event ON refunds (provider, provider_event_id) WHERE provider_event_id IS NOT NULL`,
  ]) {
    // D1's exec() splits on newlines, so the schema has to arrive as one line.
    await db.exec(sql.replace(/\s+/g, ' ').trim());
  }

  let seq = 0;
  /** Orders mutated directly by a fixture, bypassing the ledger on purpose. */
  const forcedOrders = new Set();
  const newOrder = async (opts = {}) => {
    const { total = 10000, status = 'paid', method = 'lightning', provider = 0, external = 0 } = opts;
    seq++;
    await db
      .prepare(
        `INSERT INTO orders (public_id, amount_total_cents, status, payment_method,
                             provider_refunded_cents, external_refunded_cents)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(`ord-${seq}`, total, status, method, provider, external)
      .run();
    return (await db.prepare('SELECT id FROM orders WHERE public_id = ?').bind(`ord-${seq}`).first()).id;
  };
  const totals = (id) =>
    db
      .prepare(
        'SELECT refunded_cents r, provider_refunded_cents p, external_refunded_cents e, status FROM orders WHERE id = ?',
      )
      .bind(id)
      .first();

  console.log('manual external refunds');

  await check('partial refund applies and leaves status paid', async () => {
    const id = await newOrder();
    const res = await recordExternalRefund(db, {
      orderId: id,
      amountCents: 2500,
      idempotencyKey: 'k-partial',
    });
    assert.equal(res.ok, true);
    assert.equal(res.fullyRefunded, false);
    const t = await totals(id);
    assert.equal(t.r, 2500);
    assert.equal(t.e, 2500);
    assert.equal(t.status, 'paid');
  });

  await check('refund to the full total flips status to refunded', async () => {
    const id = await newOrder();
    await recordExternalRefund(db, { orderId: id, amountCents: 4000, idempotencyKey: 'k-f1' });
    const res = await recordExternalRefund(db, {
      orderId: id,
      amountCents: 6000,
      idempotencyKey: 'k-f2',
    });
    assert.equal(res.ok, true);
    assert.equal(res.fullyRefunded, true);
    const t = await totals(id);
    assert.equal(t.r, 10000);
    assert.equal(t.status, 'refunded');
  });

  await check('replayed idempotency key applies nothing and reports duplicate', async () => {
    const id = await newOrder();
    await recordExternalRefund(db, { orderId: id, amountCents: 2500, idempotencyKey: 'k-replay' });
    const before = await totals(id);
    const res = await recordExternalRefund(db, {
      orderId: id,
      amountCents: 2500,
      idempotencyKey: 'k-replay',
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'duplicate');
    assert.equal(res.refund.amount_cents, 2500);
    const after = await totals(id);
    assert.equal(after.r, before.r, 'replay must not increment');
    assert.equal((await listRefunds(db, id)).length, 1, 'replay must not add a ledger row');
  });

  await check('over-balance is rejected as insufficient_balance, not duplicate', async () => {
    const id = await newOrder();
    const res = await recordExternalRefund(db, {
      orderId: id,
      amountCents: 10001,
      idempotencyKey: 'k-over',
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'insufficient_balance');
    assert.equal((await totals(id)).r, 0);
    assert.equal((await listRefunds(db, id)).length, 0, 'rejected claim must leave no ledger row');
  });

  await check('zero and negative amounts are rejected', async () => {
    const id = await newOrder();
    for (const amt of [0, -100, 1.5]) {
      const res = await recordExternalRefund(db, {
        orderId: id,
        amountCents: amt,
        idempotencyKey: `k-bad-${amt}`,
      });
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'invalid_amount');
    }
    assert.equal((await totals(id)).r, 0);
  });

  await check('an order that was never paid cannot be refunded', async () => {
    const id = await newOrder({ status: 'pending' });
    const res = await recordExternalRefund(db, {
      orderId: id,
      amountCents: 1000,
      idempotencyKey: 'k-unpaid',
    });
    assert.equal(res.ok, false);
    const t = await totals(id);
    assert.equal(t.r, 0);
    assert.equal(t.status, 'pending', 'must not be silently marked paid');
  });

  await check('concurrent refunds cannot exceed the order total', async () => {
    const id = await newOrder();
    const results = await Promise.all([
      recordExternalRefund(db, { orderId: id, amountCents: 6000, idempotencyKey: 'k-c1' }),
      recordExternalRefund(db, { orderId: id, amountCents: 6000, idempotencyKey: 'k-c2' }),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one may win');
    const t = await totals(id);
    assert.equal(t.r, 6000);
    assert.ok(t.r <= 10000);
  });

  await check('concurrent refunds that both fit both apply', async () => {
    const id = await newOrder();
    const results = await Promise.all([
      recordExternalRefund(db, { orderId: id, amountCents: 3000, idempotencyKey: 'k-d1' }),
      recordExternalRefund(db, { orderId: id, amountCents: 3000, idempotencyKey: 'k-d2' }),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 2);
    assert.equal((await totals(id)).r, 6000);
  });

  console.log('provider synchronisation');

  await check('cumulative total is absolute, not additive', async () => {
    const id = await newOrder({ method: 'stripe' });
    await syncProviderRefund(db, {
      orderId: id,
      cumulativeRefundedCents: 2500,
      provider: 'stripe',
      idempotencyKey: 's-1',
    });
    const res = await syncProviderRefund(db, {
      orderId: id,
      cumulativeRefundedCents: 4000,
      provider: 'stripe',
      idempotencyKey: 's-2',
    });
    assert.equal(res.advanced, true);
    assert.equal(res.deltaCents, 1500, 'ledger records the delta, not the cumulative total');
    const t = await totals(id);
    assert.equal(t.p, 4000, 'provider component holds the absolute total');
    assert.equal(t.r, 4000);
  });

  await check('duplicate provider event is a no-op', async () => {
    const id = await newOrder({ method: 'stripe' });
    await syncProviderRefund(db, {
      orderId: id,
      cumulativeRefundedCents: 3000,
      provider: 'stripe',
      idempotencyKey: 's-dup-1',
    });
    const res = await syncProviderRefund(db, {
      orderId: id,
      cumulativeRefundedCents: 3000,
      provider: 'stripe',
      idempotencyKey: 's-dup-2',
    });
    assert.equal(res.advanced, false);
    assert.equal((await totals(id)).p, 3000);
  });

  await check('out-of-order (lower) cumulative total is ignored', async () => {
    const id = await newOrder({ method: 'stripe' });
    await syncProviderRefund(db, {
      orderId: id,
      cumulativeRefundedCents: 5000,
      provider: 'stripe',
      idempotencyKey: 's-ooo-1',
    });
    const res = await syncProviderRefund(db, {
      orderId: id,
      cumulativeRefundedCents: 2000,
      provider: 'stripe',
      idempotencyKey: 's-ooo-2',
    });
    assert.equal(res.advanced, false);
    assert.equal((await totals(id)).p, 5000, 'must not regress');
  });

  await check('full provider refund flips status to refunded', async () => {
    const id = await newOrder({ method: 'stripe' });
    const res = await syncProviderRefund(db, {
      orderId: id,
      cumulativeRefundedCents: 10000,
      provider: 'stripe',
      idempotencyKey: 's-full',
    });
    assert.equal(res.fullyRefunded, true);
    assert.equal((await totals(id)).status, 'refunded');
  });

  await check('provider sync and manual refund stay independent', async () => {
    const id = await newOrder({ method: 'stripe' });
    await recordExternalRefund(db, { orderId: id, amountCents: 2000, idempotencyKey: 'm-mix' });
    await syncProviderRefund(db, {
      orderId: id,
      cumulativeRefundedCents: 3000,
      provider: 'stripe',
      idempotencyKey: 's-mix',
    });
    const t = await totals(id);
    assert.equal(t.e, 2000);
    assert.equal(t.p, 3000);
    assert.equal(t.r, 5000, 'aggregate is the sum of both components');
  });

  await check('aggregate clamps at the order total and never goes negative', async () => {
    const id = await newOrder({ method: 'stripe' });
    // Force the components past the total the way a provider disagreement would.
    // This writes around the ledger on purpose, so the ledger-sum invariant
    // below excludes it.
    forcedOrders.add(id);
    await db
      .prepare('UPDATE orders SET provider_refunded_cents = 9000, external_refunded_cents = 9000 WHERE id = ?')
      .bind(id)
      .run();
    const t = await totals(id);
    assert.equal(t.r, 10000, 'clamped at the total');
    assert.ok(t.r >= 0);
  });

  console.log('corrections');

  await check('voiding a manual refund decrements and restores status', async () => {
    const id = await newOrder();
    const made = await recordExternalRefund(db, {
      orderId: id,
      amountCents: 10000,
      idempotencyKey: 'v-1',
    });
    assert.equal((await totals(id)).status, 'refunded');
    const res = await voidRecordedRefund(db, {
      refundId: made.refund.id,
      idempotencyKey: 'v-1-void',
    });
    assert.equal(res.ok, true);
    const t = await totals(id);
    assert.equal(t.r, 0);
    assert.equal(t.status, 'paid', 'no longer refunded');
    const ledger = await listRefunds(db, id);
    assert.ok(ledger.some((r) => r.kind === 'manual_reversal' && r.amount_cents === -10000));
    // The reversed row stays 'succeeded' so the ledger still sums to the
    // external component; the reversal link is what marks it undone.
    assert.equal(ledger.find((r) => r.id === made.refund.id).status, 'succeeded');
    assert.ok(reversedRefundIds(ledger).has(made.refund.id));
  });

  await check('the same refund cannot be voided twice', async () => {
    const id = await newOrder();
    const made = await recordExternalRefund(db, {
      orderId: id,
      amountCents: 3000,
      idempotencyKey: 'v-2',
    });
    await voidRecordedRefund(db, { refundId: made.refund.id, idempotencyKey: 'v-2-void' });
    const before = await totals(id);
    const res = await voidRecordedRefund(db, {
      refundId: made.refund.id,
      idempotencyKey: 'v-2-void-again',
    });
    assert.equal(res.ok, false);
    assert.equal((await totals(id)).r, before.r, 'second void must not decrement again');
  });

  await check('provider-authoritative refunds cannot be voided', async () => {
    const id = await newOrder({ method: 'stripe' });
    const synced = await syncProviderRefund(db, {
      orderId: id,
      cumulativeRefundedCents: 2000,
      provider: 'stripe',
      idempotencyKey: 's-void',
    });
    const res = await voidRecordedRefund(db, {
      refundId: synced.refund.id,
      idempotencyKey: 's-void-void',
    });
    assert.equal(res.ok, false);
    assert.equal((await totals(id)).p, 2000);
  });

  console.log('review state');

  await check('a new conflict reopens an acknowledged review', async () => {
    const id = await newOrder();
    await openRefundReview(db, id, 'currency_mismatch');
    await acknowledgeRefundReview(db, id, 'admin');
    let o = await db
      .prepare('SELECT refund_review_reason rr, refund_reviewed_at ra FROM orders WHERE id = ?')
      .bind(id)
      .first();
    assert.ok(o.ra, 'acknowledged');

    await openRefundReview(db, id, 'exceeds_total');
    o = await db
      .prepare('SELECT refund_review_reason rr, refund_reviewed_at ra FROM orders WHERE id = ?')
      .bind(id)
      .first();
    assert.equal(o.rr, 'exceeds_total');
    assert.equal(o.ra, null, 'a new conflict must reopen the review');
  });

  console.log('provider webhook events');

  const eventStatus = (eid) =>
    db.prepare('SELECT status FROM refund_sync_events WHERE provider_event_id = ?').bind(eid).first();
  const withPi = async (pi) => {
    const id = await newOrder({ method: 'stripe' });
    await db.prepare('UPDATE orders SET provider_payment_id = ? WHERE id = ?').bind(pi, id).run();
    return id;
  };
  const evt = (o) => ({ providerChargeId: 'ch_x', currency: 'usd', ...o });

  await check('a refund event applies to the order it names', async () => {
    const id = await withPi('pi_ok');
    const input = evt({ eventId: 'ev_ok', providerPaymentId: 'pi_ok', cumulativeRefundedCents: 2500 });
    await persistRefundEvent(db, 'stripe', input);
    const out = await applyRefundEvent(db, 'stripe', input);
    assert.equal(out.status, 'processed');
    assert.equal(out.deltaCents, 2500);
    assert.equal((await totals(id)).p, 2500);
    assert.equal((await eventStatus('ev_ok')).status, 'processed');
  });

  await check('a redelivered event changes nothing', async () => {
    const id = await withPi('pi_dup');
    const input = evt({ eventId: 'ev_dup', providerPaymentId: 'pi_dup', cumulativeRefundedCents: 2500 });
    await persistRefundEvent(db, 'stripe', input);
    await applyRefundEvent(db, 'stripe', input);
    // Exactly what Stripe does on retry: same event id, same payload.
    await persistRefundEvent(db, 'stripe', input);
    const out = await applyRefundEvent(db, 'stripe', input);
    assert.equal(out.status, 'no_change');
    assert.equal((await totals(id)).p, 2500);
    const n = await db
      .prepare("SELECT COUNT(*) n FROM refunds WHERE order_id = ? AND kind = 'provider_sync'")
      .bind(id)
      .first();
    assert.equal(n.n, 1, 'a retry must not add a second ledger row');
  });

  await check('two partial refunds on the SAME charge both apply', async () => {
    // Every charge.refunded for one charge repeats the same charge id. If that
    // id is written to the ledger's provider_refund_id, the second partial
    // violates the unique index, the batch throws, and Stripe retries forever.
    const id = await withPi('pi_two');
    const first = evt({
      eventId: 'ev_two_a',
      providerPaymentId: 'pi_two',
      providerChargeId: 'ch_same',
      cumulativeRefundedCents: 2000,
    });
    await persistRefundEvent(db, 'stripe', first);
    assert.equal((await applyRefundEvent(db, 'stripe', first)).status, 'processed');

    const second = evt({
      eventId: 'ev_two_b',
      providerPaymentId: 'pi_two',
      providerChargeId: 'ch_same', // same charge, second partial
      cumulativeRefundedCents: 5000,
    });
    await persistRefundEvent(db, 'stripe', second);
    const out = await applyRefundEvent(db, 'stripe', second);
    assert.equal(out.status, 'processed', 'second partial on the same charge must apply');
    assert.equal(out.deltaCents, 3000);
    assert.equal((await totals(id)).p, 5000);
  });

  await check('an event for an unknown payment is kept, not lost', async () => {
    const input = evt({ eventId: 'ev_unk', providerPaymentId: 'pi_missing', cumulativeRefundedCents: 900 });
    await persistRefundEvent(db, 'stripe', input);
    const out = await applyRefundEvent(db, 'stripe', input);
    assert.equal(out.status, 'unmatched');
    assert.equal((await eventStatus('ev_unk')).status, 'unmatched');
  });

  await check('an unmatched event can be retried after the id is backfilled', async () => {
    const input = evt({ eventId: 'ev_retry', providerPaymentId: 'pi_late', cumulativeRefundedCents: 1500 });
    await persistRefundEvent(db, 'stripe', input);
    assert.equal((await applyRefundEvent(db, 'stripe', input)).status, 'unmatched');
    const id = await withPi('pi_late'); // the legacy backfill
    const out = await applyRefundEvent(db, 'stripe', input);
    assert.equal(out.status, 'processed');
    assert.equal((await totals(id)).p, 1500);
  });

  await check('a legacy order is correlated via the provider session lookup', async () => {
    // Settled before payment ids were stored: session id only.
    const id = await newOrder({ method: 'stripe' });
    await db
      .prepare('UPDATE orders SET provider_session_id = ? WHERE id = ?')
      .bind('cs_legacy', id)
      .run();
    const input = evt({
      eventId: 'ev_corr',
      providerPaymentId: 'pi_legacy',
      cumulativeRefundedCents: 3000,
    });
    await persistRefundEvent(db, 'stripe', input);
    const out = await applyRefundEvent(db, 'stripe', input, {
      findSessionIdForPayment: async (pi) => (pi === 'pi_legacy' ? 'cs_legacy' : null),
    });
    assert.equal(out.status, 'processed', 'lookup should have correlated it');
    assert.equal((await totals(id)).p, 3000);
    const o = await db
      .prepare('SELECT provider_payment_id p FROM orders WHERE id = ?')
      .bind(id)
      .first();
    assert.equal(o.p, 'pi_legacy', 'payment id must be backfilled');
  });

  await check('a failing lookup keeps the event queued instead of throwing', async () => {
    const input = evt({
      eventId: 'ev_lookup_down',
      providerPaymentId: 'pi_down',
      cumulativeRefundedCents: 1000,
    });
    await persistRefundEvent(db, 'stripe', input);
    const out = await applyRefundEvent(db, 'stripe', input, {
      findSessionIdForPayment: async () => {
        throw new Error('provider unavailable');
      },
    });
    assert.equal(out.status, 'unmatched');
    assert.equal((await eventStatus('ev_lookup_down')).status, 'unmatched');
  });

  await check('correlation never steals a session already claimed', async () => {
    const owner = await newOrder({ method: 'stripe' });
    await db
      .prepare("UPDATE orders SET provider_session_id = 'cs_taken', provider_payment_id = 'pi_owner' WHERE id = ?")
      .bind(owner)
      .run();
    const input = evt({
      eventId: 'ev_steal',
      providerPaymentId: 'pi_other',
      cumulativeRefundedCents: 500,
    });
    await persistRefundEvent(db, 'stripe', input);
    const out = await applyRefundEvent(db, 'stripe', input, {
      findSessionIdForPayment: async () => 'cs_taken',
    });
    assert.equal(out.status, 'unmatched');
    const o = await db.prepare('SELECT provider_payment_id p FROM orders WHERE id = ?').bind(owner).first();
    assert.equal(o.p, 'pi_owner', 'existing payment id must not be overwritten');
  });

  await check('a currency mismatch opens a review and moves no money', async () => {
    const id = await withPi('pi_cur');
    const input = evt({
      eventId: 'ev_cur',
      providerPaymentId: 'pi_cur',
      cumulativeRefundedCents: 5000,
      currency: 'eur',
    });
    await persistRefundEvent(db, 'stripe', input);
    const out = await applyRefundEvent(db, 'stripe', input);
    assert.equal(out.status, 'review');
    assert.equal(out.reason, 'currency_mismatch');
    assert.equal((await totals(id)).p, 0, 'totals must be untouched');
    const o = await db
      .prepare('SELECT refund_review_reason rr, refund_reviewed_at ra FROM orders WHERE id = ?')
      .bind(id)
      .first();
    assert.equal(o.rr, 'currency_mismatch');
    assert.equal(o.ra, null);
  });

  await check('provider plus manual exceeding the total opens a review', async () => {
    const id = await withPi('pi_over');
    await recordExternalRefund(db, { orderId: id, amountCents: 6000, idempotencyKey: 'ex-over' });
    const input = evt({ eventId: 'ev_over', providerPaymentId: 'pi_over', cumulativeRefundedCents: 8000 });
    await persistRefundEvent(db, 'stripe', input);
    const out = await applyRefundEvent(db, 'stripe', input);
    assert.equal(out.status, 'review');
    assert.equal(out.reason, 'exceeds_order_total');
    const t = await totals(id);
    // Both numbers are kept; only the derived aggregate is clamped.
    assert.equal(t.p, 8000);
    assert.equal(t.e, 6000);
    assert.equal(t.r, 10000);
  });

  console.log('invariants');

  await check('no order ever drifted from its components', async () => {
    const row = await db
      .prepare(
        `SELECT COUNT(*) n FROM orders
          WHERE refunded_cents <> MIN(amount_total_cents,
                                      provider_refunded_cents + external_refunded_cents)`,
      )
      .first();
    assert.equal(row.n, 0);
  });

  await check('net revenue never went negative', async () => {
    const row = await db
      .prepare('SELECT COUNT(*) n FROM orders WHERE amount_total_cents - refunded_cents < 0')
      .first();
    assert.equal(row.n, 0);
  });

  await check('every succeeded manual refund sums to the external component', async () => {
    const rows = await db
      .prepare(
        `SELECT o.id,
                o.external_refunded_cents e,
                COALESCE((SELECT SUM(r.amount_cents) FROM refunds r
                           WHERE r.order_id = o.id AND r.status = 'succeeded'
                             AND r.kind IN ('manual_external','demo','manual_reversal')), 0) s
           FROM orders o`,
      )
      .all();
    for (const r of rows.results) {
      if (forcedOrders.has(r.id)) continue;
      assert.equal(r.e, r.s, `order ${r.id}: external ${r.e} != ledger sum ${r.s}`);
    }
    assert.ok(rows.results.length > forcedOrders.size, 'invariant covered no real orders');
  });
} finally {
  await mf.dispose();
}

if (failures > 0) {
  console.error(`\n${failures} refund check(s) failed`);
  process.exit(1);
}
console.log('\nrefund accounting: all checks passed');
