/**
 * Pull Click & Drop print/despatch state into minshop fulfillment.
 *
 * C&D has no outbound webhook for custom API keys — Shopify-style channels are
 * updated by Royal Mail. We poll GET /orders/{id} from Admin and the cron.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { deliverOrderNotifications } from '../email/outbox.ts';
import { queueNotification } from '../email/outboxStore.ts';
import { shouldSendCustomerOrderEmail } from '../email/orderPolicy.ts';
import { getEmailProvider } from '../email';
import {
  fulfillOrder,
  getOrder,
  type Order,
} from '../orders/db.ts';
import { getStoreSettings } from '../settings/db.ts';
import {
  clickDropLooksDespatched,
  fetchClickDropOrder,
  type ClickDropRemoteStatus,
} from './clickDrop.ts';

export type ClickDropSyncOutcome =
  | { status: 'fulfilled'; trackingNumber: string | null; remote: ClickDropRemoteStatus }
  | { status: 'pending'; remote: ClickDropRemoteStatus }
  | { status: 'already_fulfilled' }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string; uncertain?: boolean };

/** Paid, unfulfilled shop orders that were pushed to Click & Drop. */
export async function listOrdersAwaitingClickDropSync(
  db: D1Database,
  limit = 25,
): Promise<Order[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM orders
        WHERE click_drop_order_id IS NOT NULL
          AND fulfillment_status = 'unfulfilled'
          AND status = 'paid'
        ORDER BY click_drop_pushed_at ASC
        LIMIT ?`,
    )
    .bind(limit)
    .all<Order>();
  return results ?? [];
}

/**
 * Fulfill one order from its C&D remote status when despatched/printed.
 * Idempotent: already-fulfilled orders are a no-op.
 */
export async function syncOneClickDropOrder(
  db: D1Database,
  apiKey: string,
  order: Order,
  opts?: { origin?: string | null },
): Promise<ClickDropSyncOutcome> {
  if (order.fulfillment_status === 'fulfilled') {
    return { status: 'already_fulfilled' };
  }
  if (order.click_drop_order_id == null) {
    return { status: 'skipped', reason: 'Order has not been pushed to Click & Drop.' };
  }
  if (order.status !== 'paid') {
    return { status: 'skipped', reason: 'Order is not paid.' };
  }

  const remote = await fetchClickDropOrder(apiKey, order.click_drop_order_id);
  if (!remote.ok) {
    return { status: 'error', error: remote.error, uncertain: remote.uncertain };
  }

  if (!clickDropLooksDespatched(remote.value)) {
    return { status: 'pending', remote: remote.value };
  }

  const tracking = remote.value.trackingNumber;
  const fulfilled = await fulfillOrder(db, order.id, 'royal_mail', tracking);
  if (!fulfilled) {
    // Race with a label purchase or concurrent sync.
    const again = await getOrder(db, order.id);
    if (again?.fulfillment_status === 'fulfilled') {
      return { status: 'already_fulfilled' };
    }
    return {
      status: 'error',
      error:
        'Could not mark the order fulfilled — a label purchase may be in progress. Try again shortly.',
    };
  }

  await queueNotification(db, order.id, 'order-shipped');
  const origin = opts?.origin?.trim() || null;
  if (origin) {
    try {
      const settings = await getStoreSettings(db);
      const fresh = await getOrder(db, order.id);
      if (
        fresh?.email &&
        shouldSendCustomerOrderEmail(fresh.payment_method) &&
        (await getEmailProvider(settings))
      ) {
        await deliverOrderNotifications(db, order.id, origin, settings);
      }
    } catch (err) {
      console.error('Click & Drop sync: shipped-notification delivery failed:', err);
    }
  }

  return { status: 'fulfilled', trackingNumber: tracking, remote: remote.value };
}

export interface ClickDropSweepResult {
  checked: number;
  fulfilled: number;
  pending: number;
  errors: number;
}

/** Cron / batch: sync up to `limit` awaiting orders. */
export async function syncPendingClickDropOrders(
  db: D1Database,
  apiKey: string,
  opts?: { limit?: number; origin?: string | null },
): Promise<ClickDropSweepResult> {
  const orders = await listOrdersAwaitingClickDropSync(db, opts?.limit ?? 25);
  const result: ClickDropSweepResult = { checked: 0, fulfilled: 0, pending: 0, errors: 0 };
  for (const order of orders) {
    result.checked += 1;
    const outcome = await syncOneClickDropOrder(db, apiKey, order, { origin: opts?.origin });
    if (outcome.status === 'fulfilled') result.fulfilled += 1;
    else if (outcome.status === 'pending' || outcome.status === 'already_fulfilled') {
      if (outcome.status === 'pending') result.pending += 1;
    } else if (outcome.status === 'error') result.errors += 1;
  }
  return result;
}
