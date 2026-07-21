import type { D1Database } from '@cloudflare/workers-types';
import type { PaidOrderInput, OrderItemInput, ShippingAddress } from '../../orders/db';

/**
 * Pending Lightning payments — the in-flight state between minting a BOLT11
 * invoice and the customer paying it. NOT an order until settled (see
 * migrations/0014). Used only by the self-rendered backends (phoenixd / LNbits);
 * OpenNode also uses it because its webhook cannot echo application state.
 */
export interface PendingPayment {
  id: number;
  public_id: string;
  payment_hash: string;
  backend: string;
  bolt11: string | null; // null for hosted (opennode) — no invoice to render
  amount_sat: number | null;
  amount_total_cents: number;
  currency: string;
  email: string | null;
  items: string | null; // JSON: [{ id, q, n, p }]
  shipping_cents: number;
  ship_address: string | null; // JSON (ShippingAddress) or null
  /** Explicit link for post-0021 rows; null preserves legacy settlement. */
  reservation_id: string | null;
  status: string; // 'pending' | 'settled' | 'expired'
  expires_at: string | null;
  created_at: string;
}

export interface NewPendingPayment {
  publicId: string;
  paymentHash: string;
  backend: string;
  bolt11: string | null;
  amountSat: number | null;
  amountTotalCents: number;
  currency: string;
  email: string | null;
  /** Pre-serialized JSON cart snapshot persisted server-side. */
  itemsJson: string | null;
  shippingCents?: number;
  /** Pre-serialized JSON ShippingAddress, or null. */
  shipAddressJson?: string | null;
  /** Inventory hold created with this payment; absent for demo and legacy rows. */
  reservationId?: string | null;
  expiresAt: string | null;
}

export async function createPendingPayment(db: D1Database, p: NewPendingPayment): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pending_payments
         (public_id, payment_hash, backend, bolt11, amount_sat, amount_total_cents, currency, email, items, shipping_cents, ship_address, expires_at, reservation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      p.publicId,
      p.paymentHash,
      p.backend,
      p.bolt11,
      p.amountSat,
      p.amountTotalCents,
      p.currency,
      p.email,
      p.itemsJson,
      p.shippingCents ?? 0,
      p.shipAddressJson ?? null,
      p.expiresAt,
      p.reservationId ?? null,
    )
    .run();
}

export async function getPendingByPublicId(
  db: D1Database,
  publicId: string,
): Promise<PendingPayment | null> {
  return db
    .prepare('SELECT * FROM pending_payments WHERE public_id = ?')
    .bind(publicId)
    .first<PendingPayment>();
}

export async function getPendingByHash(
  db: D1Database,
  paymentHash: string,
): Promise<PendingPayment | null> {
  return db
    .prepare('SELECT * FROM pending_payments WHERE payment_hash = ?')
    .bind(paymentHash)
    .first<PendingPayment>();
}

/** Flip a pending row to 'settled' (idempotent — recordPaidOrder is the real guard). */
export async function markPendingSettled(db: D1Database, paymentHash: string): Promise<void> {
  await db
    .prepare(`UPDATE pending_payments SET status = 'settled' WHERE payment_hash = ?`)
    .bind(paymentHash)
    .run();
}

/**
 * Build a PaidOrderInput from a settled pending row (pure). The cart snapshot was
 * stored as the compact checkout snapshot shape: [{ id, q, n, p }].
 * Lives here (not in a provider) so it stays free of `cloudflare:workers` imports
 * and is unit-testable. Shared by the Lightning and OpenNode providers.
 */
export function pendingToPaidOrder(p: PendingPayment): PaidOrderInput {
  let items: OrderItemInput[] = [];
  if (p.items) {
    try {
      const raw = JSON.parse(p.items) as {
        id: number;
        q: number;
        n: string;
        p: number;
        v?: number | null;
      }[];
      items = raw.map((r) => ({
        productId: r.id,
        variantId: r.v ?? null,
        name: r.n,
        priceCents: r.p,
        quantity: r.q,
      }));
    } catch {
      items = [];
    }
  }
  let shippingAddress: ShippingAddress | null = null;
  if (p.ship_address) {
    try {
      shippingAddress = JSON.parse(p.ship_address) as ShippingAddress;
    } catch {
      shippingAddress = null;
    }
  }
  return {
    providerSessionId: p.payment_hash,
    publicId: p.public_id,
    reservationId: p.reservation_id ?? undefined,
    email: p.email,
    amountTotalCents: p.amount_total_cents,
    shippingCents: p.shipping_cents,
    shippingAddress,
    currency: p.currency,
    items,
  };
}
