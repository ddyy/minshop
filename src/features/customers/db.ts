import type { D1Database } from '@cloudflare/workers-types';
import type { Order } from '../orders/db';

/**
 * Customers are not a stored entity — minshop is guest-checkout. This is a
 * read-only view derived from the orders table (grouped by email), so there's
 * no extra PII collected beyond what orders already hold.
 */
export interface CustomerSummary {
  email: string;
  orders: number;
  lifetime_cents: number;
  last_order: string;
}

/** Distinct customers (by email) with order count, lifetime value, last order. */
export async function listCustomers(
  db: D1Database,
  orderBy = 'lifetime_cents DESC',
): Promise<CustomerSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT email,
              COUNT(*)                              AS orders,
              SUM(amount_total_cents - refunded_cents) AS lifetime_cents,
              MAX(created_at)                       AS last_order
         FROM orders
        WHERE email IS NOT NULL AND email != ''
        GROUP BY email
        ORDER BY ${orderBy}`,
    )
    .all<CustomerSummary>();
  return results ?? [];
}

/** Distinct customer count (for the dashboard). */
export async function countCustomers(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(DISTINCT email) AS n FROM orders WHERE email IS NOT NULL AND email != ''",
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** All orders for one customer email, newest first. */
export async function getCustomerOrders(db: D1Database, email: string): Promise<Order[]> {
  const { results } = await db
    .prepare('SELECT * FROM orders WHERE email = ? ORDER BY created_at DESC')
    .bind(email)
    .all<Order>();
  return results ?? [];
}
