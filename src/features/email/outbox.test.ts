import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';

// The outbox's collaborators are mocked; what is under test here is the state
// machine — claim exclusivity, sent/skipped/dead transitions, retry counting.
// The SQL itself runs for real in scripts/test-reservations.mjs (row birth in
// the order batch) and the wrangler integration gate.
vi.mock('./index', () => ({ getEmailProvider: vi.fn() }));
vi.mock('../orders/db', () => ({ getOrder: vi.fn(), listOrderItemsWithImages: vi.fn() }));
vi.mock('../settings/db', () => ({ getStoreSettings: vi.fn() }));
vi.mock('./orderConfirmation', () => ({
  orderConfirmationEmail: vi.fn(() => ({ to: 'c@x', subject: 'r', html: '', text: '' })),
  orderNotificationEmail: vi.fn(() => ({ to: 'o@x', subject: 'n', html: '', text: '' })),
}));

import { deliverOrderNotifications } from './outbox';
import { getEmailProvider } from './index';
import { getOrder, listOrderItemsWithImages } from '../orders/db';

interface Row {
  order_id: number;
  kind: string;
  state: string;
  attempts: number;
  lease_expires_at: string | null;
  last_error: string | null;
}

/**
 * Tiny in-memory stand-in for the order_notifications table, interpreting the
 * exact statements outbox.ts issues (recognized by their SET clauses). Leases
 * are compared as ISO strings, same as SQLite's datetime() text ordering.
 */
function fakeDb(rows: Row[]): D1Database {
  const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  const find = (id: number, kind: string) => rows.find((r) => r.order_id === id && r.kind === kind);
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("SET state = 'processing'")) {
                const [id, kind] = args as [number, string];
                const r = find(id, kind);
                if (!r || r.attempts >= 5) return null;
                const claimable =
                  r.state === 'pending' ||
                  (r.state === 'processing' && r.lease_expires_at != null && r.lease_expires_at < now());
                if (!claimable) return null;
                r.state = 'processing';
                r.attempts += 1;
                r.lease_expires_at = '9999-12-31 00:00:00';
                return { attempts: r.attempts };
              }
              throw new Error(`unexpected first(): ${sql}`);
            },
            async run() {
              if (sql.includes("SET state = 'dead'")) {
                // The park: abandoned claim with attempts exhausted.
                const [id, kind] = args as [number, string];
                const r = find(id, kind);
                if (
                  r?.state === 'processing' &&
                  r.lease_expires_at != null &&
                  r.lease_expires_at < now() &&
                  r.attempts >= 5
                ) {
                  Object.assign(r, {
                    state: 'dead',
                    lease_expires_at: null,
                    last_error: r.last_error ?? 'delivery repeatedly interrupted (lease expired)',
                  });
                }
                return {};
              }
              // Completion updates carry the fencing token as the last bind.
              if (sql.includes("state = 'sent'") || sql.includes("SET state = 'sent'")) {
                const [id, kind, attempts] = args as [number, string, number];
                const r = find(id, kind);
                if (r?.state === 'processing' && r.attempts === attempts)
                  Object.assign(r, { state: 'sent', lease_expires_at: null, last_error: null });
                return {};
              }
              if (sql.includes("SET state = 'skipped'")) {
                const [id, kind, attempts] = args as [number, string, number];
                const r = find(id, kind);
                if (r?.state === 'processing' && r.attempts === attempts)
                  Object.assign(r, { state: 'skipped', lease_expires_at: null });
                return {};
              }
              if (sql.startsWith(`UPDATE order_notifications\n          SET state = ?`)) {
                const [state, err, id, kind, attempts] = args as [string, string, number, string, number];
                const r = find(id, kind);
                if (r?.state === 'processing' && r.attempts === attempts)
                  Object.assign(r, { state, last_error: err, lease_expires_at: null });
                return {};
              }
              throw new Error(`unexpected run(): ${sql}`);
            },
            async all() {
              throw new Error(`unexpected all(): ${sql}`);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const SETTINGS = {
  emailNotifyTo: 'owner@example.com',
  storeName: 'Test Shop',
  imageDelivery: 'original',
} as never;

const ORDER = { id: 7, email: 'buyer@example.com', payment_method: 'stripe' };

function freshRows(): Row[] {
  return ['customer-receipt', 'owner-notification'].map((kind) => ({
    order_id: 7,
    kind,
    state: 'pending',
    attempts: 0,
    lease_expires_at: null,
    last_error: null,
  }));
}

describe('deliverOrderNotifications', () => {
  const send = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEmailProvider).mockResolvedValue({ send });
    vi.mocked(getOrder).mockResolvedValue(ORDER as never);
    vi.mocked(listOrderItemsWithImages).mockResolvedValue([] as never);
    send.mockResolvedValue(undefined);
  });

  it('sends both kinds and marks them sent, with per-notification keys', async () => {
    const rows = freshRows();
    await deliverOrderNotifications(fakeDb(rows), 7, 'https://x', SETTINGS);
    expect(rows.map((r) => r.state)).toEqual(['sent', 'sent']);
    expect(send.mock.calls.map(([m]) => m.idempotencyKey)).toEqual([
      'customer-receipt/7',
      'owner-notification/7',
    ]);
  });

  it('is a no-op on a second pass (claim exclusivity)', async () => {
    const rows = freshRows();
    const db = fakeDb(rows);
    await deliverOrderNotifications(db, 7, 'https://x', SETTINGS);
    await deliverOrderNotifications(db, 7, 'https://x', SETTINGS);
    expect(send).toHaveBeenCalledTimes(2); // not 4
  });

  it('skips the customer receipt for demo orders, still notifies the owner', async () => {
    vi.mocked(getOrder).mockResolvedValue({ ...ORDER, payment_method: 'demo' } as never);
    const rows = freshRows();
    await deliverOrderNotifications(fakeDb(rows), 7, 'https://x', SETTINGS);
    expect(rows.map((r) => r.state)).toEqual(['skipped', 'sent']);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('skips both when email is disabled, without consuming retries as failures', async () => {
    vi.mocked(getEmailProvider).mockResolvedValue(null);
    const rows = freshRows();
    await deliverOrderNotifications(fakeDb(rows), 7, 'https://x', SETTINGS);
    expect(rows.map((r) => r.state)).toEqual(['skipped', 'skipped']);
    expect(send).not.toHaveBeenCalled();
  });

  it('releases a failed send back to pending with the error recorded', async () => {
    send.mockRejectedValueOnce(new Error('smtp down'));
    const rows = freshRows();
    await deliverOrderNotifications(fakeDb(rows), 7, 'https://x', SETTINGS);
    expect(rows[0]).toMatchObject({ state: 'pending', attempts: 1, last_error: 'smtp down' });
    expect(rows[1].state).toBe('sent'); // one kind's failure never blocks the other
  });

  it('parks a row as dead once attempts are exhausted', async () => {
    send.mockRejectedValue(new Error('hard bounce'));
    const rows = freshRows();
    const db = fakeDb(rows);
    for (let i = 0; i < 5; i++) await deliverOrderNotifications(db, 7, 'https://x', SETTINGS);
    expect(rows[0]).toMatchObject({ state: 'dead', attempts: 5 });
    await deliverOrderNotifications(db, 7, 'https://x', SETTINGS);
    expect(rows[0].attempts).toBe(5); // dead rows are never re-claimed
  });

  it('parks an abandoned claim as dead once its attempts are spent', async () => {
    // The waitUntil-cancellation shape: the worker died mid-send five times —
    // attempts were consumed at claim time, but no completion mark ever ran.
    // The row sits in processing with an expired lease and must be parked,
    // not silently reclaimed forever (and never sent again).
    const rows = freshRows();
    rows[0] = { ...rows[0], state: 'processing', attempts: 5, lease_expires_at: '2000-01-01 00:00:00' };
    rows[1].state = 'sent';
    await deliverOrderNotifications(fakeDb(rows), 7, 'https://x', SETTINGS);
    expect(rows[0]).toMatchObject({ state: 'dead', attempts: 5 });
    expect(rows[0].last_error).toMatch(/interrupted/);
    expect(send).not.toHaveBeenCalled();
  });

  it("fences a stale claim: attempt 1 completing late cannot overwrite attempt 2's live claim", async () => {
    const rows = freshRows();
    rows[1].state = 'sent';
    const db = fakeDb(rows);
    // Worker A: claim succeeds (attempts=1), but its send hangs past the lease.
    let releaseA!: () => void;
    send.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseA = () => resolve(); }),
    );
    const a = deliverOrderNotifications(db, 7, 'https://x', SETTINGS);
    await vi.waitFor(() => expect(rows[0].attempts).toBe(1));
    // A's lease expires; worker B reclaims (attempts=2) and is mid-send.
    rows[0].lease_expires_at = '2000-01-01 00:00:00';
    let releaseB!: () => void;
    send.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseB = () => resolve(); }),
    );
    const b = deliverOrderNotifications(db, 7, 'https://x', SETTINGS);
    await vi.waitFor(() => expect(rows[0].attempts).toBe(2));
    // A's send finally resolves — its markSent carries token 1, row is at 2.
    releaseA();
    await a;
    expect(rows[0].state).toBe('processing'); // B's live claim untouched
    expect(rows[0].lease_expires_at).not.toBeNull();
    // B completes normally with the matching token.
    releaseB();
    await b;
    expect(rows[0].state).toBe('sent');
  });

  it('reclaims an expired lease from a dead deliverer', async () => {
    const rows = freshRows();
    rows[0].state = 'processing';
    rows[0].lease_expires_at = '2000-01-01 00:00:00';
    rows[1].state = 'sent';
    await deliverOrderNotifications(fakeDb(rows), 7, 'https://x', SETTINGS);
    expect(rows[0].state).toBe('sent');
  });
});
