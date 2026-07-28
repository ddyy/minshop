import type { D1Database } from '@cloudflare/workers-types';
import {
  NOTIFICATION_KINDS,
  claimNotification as claim,
  markNotificationSent as markSent,
  markNotificationSkipped as markSkipped,
  markNotificationFailed as markFailed,
  listUndeliveredKinds,
  isGuestLinkReissueKind,
  reissueGeneration,
  type NotificationKind,
} from './outboxStore';

export { NOTIFICATION_KINDS, type NotificationKind } from './outboxStore';
import { getConfig } from '../../config';
import { getStoreSettings, type StoreSettings } from '../settings/db';
import { getOrder, listOrderItemsWithImages } from '../orders/db';
import { getEmailProvider } from './index';
import { orderConfirmationEmail, orderNotificationEmail } from './orderConfirmation';
import { guestLinkReissueEmail } from './guestLinkReissue';
import { guestOrderUrl, getGuestAccess, sweepAbandonedGuestAccess } from '../orders/guestAccess.ts';
import { shouldSendCustomerOrderEmail } from './orderPolicy';

/**
 * Transactional-email outbox (see migration 0032). recordPaidOrder commits one
 * row per email in the same batch as the order; this module is everything that
 * happens to a row afterwards: claim → build → send → mark.
 *
 * Delivery is at-least-once by choice — a row is marked 'sent' only after the
 * send succeeds, so a crash in between can duplicate (Resend's idempotency key
 * absorbs that for 24h; the Cloudflare binding has no equivalent). The claim
 * is a conditional UPDATE, so the concurrent deliverers — settlement itself,
 * a webhook redelivery, the piggyback sweep — cannot double-send a live row.
 *
 * The state-machine SQL itself lives in outboxStore.ts, dependency-free so the
 * reservations integration script exercises it against a real D1.
 */

/** Rows younger than this are left to their own settlement's deliverer. */
const SWEEP_MIN_AGE_SECONDS = 120;
/** Stale rows recovered per sweep. Small on purpose: the sweep piggybacks on
 *  live settlements, and one slow backlog must not snowball into them. */
const SWEEP_BATCH = 3;

/**
 * Deliver whatever undelivered notifications an order still has. Safe to call
 * from anywhere, any number of times — the claim makes repeats no-ops. This is
 * what closes the old redelivery gap: a webhook retry that finds the order
 * already recorded calls this instead of returning with the emails unsent.
 */
export async function deliverOrderNotifications(
  db: D1Database,
  orderId: number,
  origin: string,
  settings?: StoreSettings,
): Promise<void> {
  // Settings resolve once per delivery pass, at send time — a store that
  // enabled email after the order was placed still gets the sends.
  const s = settings ?? (await getStoreSettings(db));
  let order: Awaited<ReturnType<typeof getOrder>> | undefined;
  let items: Awaited<ReturnType<typeof listOrderItemsWithImages>> | undefined;

  // The order's own undelivered rows, not the fixed kind list: reissue rows
  // carry versioned kinds (guest-link-reissue:<generation>) that a fixed list
  // could never enumerate. The claim below still gates every one of them.
  const undelivered = await listUndeliveredKinds(db, orderId);
  const kinds = undelivered.filter(
    (k): k is NotificationKind =>
      (NOTIFICATION_KINDS as readonly string[]).includes(k) || isGuestLinkReissueKind(k),
  );

  for (const kind of kinds) {
    const attempts = await claim(db, orderId, kind);
    if (attempts == null) continue;
    try {
      const emailer = await getEmailProvider(s);
      if (!emailer) {
        if (isGuestLinkReissueKind(kind)) {
          // A reissue already killed the old links — its email is a CREDENTIAL
          // delivery, so a temporarily unconfigured provider is a retryable
          // failure (sweep picks it up), never a terminal skip. Reissue also
          // refuses up front when email is off, so this is the rare race.
          await markFailed(db, orderId, kind, attempts, 'Email provider unavailable');
          continue;
        }
        // Email is off for this store: not-applicable, not a failure.
        await markSkipped(db, orderId, kind, attempts);
        continue;
      }
      order ??= await getOrder(db, orderId);
      if (!order) {
        // Row without an order should be impossible (same-batch insert);
        // treat as terminal rather than retrying forever.
        await markFailed(db, orderId, kind, attempts, 'Order row not found', true);
        continue;
      }
      const notifyTo = s.emailNotifyTo || getConfig().email.notifyTo;
      const storeName = s.storeName || getConfig().storeName;

      // Guest-link reissue: a stale event — one whose generation no longer
      // matches order_guest_access.generation because a newer reissue already
      // replaced that token — is SKIPPED, never sent: emailing it would hand
      // the customer a link the newer reissue already invalidated.
      if (isGuestLinkReissueKind(kind)) {
        const access = order.public_id ? await getGuestAccess(db, order.public_id) : null;
        const applicable =
          Boolean(order.email) &&
          shouldSendCustomerOrderEmail(order.payment_method) &&
          access !== null &&
          access.generation === reissueGeneration(kind);
        if (!applicable) {
          await markSkipped(db, orderId, kind, attempts);
          continue;
        }
        // Customer email is an allowlisted token position (the ONLY delivery
        // path for a reissued credential — admin output never shows it).
        const msg = guestLinkReissueEmail(order, storeName, `${origin}/order/${access.access_token}`);
        await emailer.send({ ...msg, idempotencyKey: `${kind}/${order.public_id ?? orderId}` });
        await markSent(db, orderId, kind, attempts);
        continue;
      }

      const applicable =
        kind === 'customer-receipt'
          ? Boolean(order.email) && shouldSendCustomerOrderEmail(order.payment_method)
          : Boolean(notifyTo);
      if (!applicable) {
        await markSkipped(db, orderId, kind, attempts);
        continue;
      }
      items ??= await listOrderItemsWithImages(db, orderId);
      const msg =
        kind === 'customer-receipt'
          ? orderConfirmationEmail(
              order,
              items,
              origin,
              storeName,
              s.imageDelivery,
              // Tokenized guest link — customer email is an allowlisted token
              // position. The owner notification links to admin instead.
              await guestOrderUrl(db, order.public_id, origin),
            )
          : orderNotificationEmail(order, items, notifyTo!, origin, storeName, s.imageDelivery);
      // Keyed on public_id, not the row id: D1 ids restart per store, so two
      // stores sharing one Resend account would both mint customer-receipt/1 —
      // and Resend 409s a reused key with a different payload, walking the
      // second store's row to 'dead'. public_id is globally random; the id
      // fallback is only for pre-0005 legacy rows without one.
      await emailer.send({ ...msg, idempotencyKey: `${kind}/${order.public_id ?? orderId}` });
      await markSent(db, orderId, kind, attempts);
    } catch (err) {
      console.error(`Order notification ${kind}/${order?.public_id ?? '(unresolved order)'} failed:`, err);
      await markFailed(db, orderId, kind, attempts, err);
    }
  }
}

/**
 * Recover a few stale rows: expired-lease claims from dead deliverers, and
 * pending rows old enough that their own settlement clearly isn't coming back
 * for them. Piggybacks on live settlements (no cron in the Astro worker yet),
 * so it is deliberately tiny — a backlog drains a little on every sale.
 */
export async function sweepStaleNotifications(db: D1Database, origin: string): Promise<void> {
  // Piggyback the guest-credential reconciliation here too: same cadence, same
  // bounded-work philosophy, and this is the only recurring hook the Worker has.
  try {
    await sweepAbandonedGuestAccess(db);
  } catch (err) {
    console.error('Guest-access sweep failed:', err);
  }
  const { results } = await db
    .prepare(
      `SELECT DISTINCT order_id FROM order_notifications
        WHERE (state = 'pending' AND created_at < datetime('now', '-${SWEEP_MIN_AGE_SECONDS} seconds'))
           OR (state = 'processing' AND lease_expires_at < datetime('now'))
        ORDER BY created_at
        LIMIT ${SWEEP_BATCH}`,
    )
    .all<{ order_id: number }>();
  for (const row of results ?? []) {
    await deliverOrderNotifications(db, row.order_id, origin);
  }
}
