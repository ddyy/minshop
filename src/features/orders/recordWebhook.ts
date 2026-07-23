import { env } from 'cloudflare:workers';
import type { WebhookResult } from '../payments/provider';
import {
  recordPaidOrder,
  getOrder,
  getOrderByProviderSessionId,
  listOrderItemsWithImages,
} from './db';
import { getEmailProvider } from '../email';
import { orderConfirmationEmail, orderNotificationEmail } from '../email/orderConfirmation';
import { getConfig } from '../../config';
import { getSetting } from '../settings/db';
import {
  getActiveReservationItems,
  markInventoryReservationPaymentPending,
  releaseInventoryReservation,
} from './reservations';
import { markPendingSettled } from '../payments/lightning/pending';

/**
 * Persist a verified paid-webhook order (idempotent on the provider session id)
 * and fire the confirmation + owner-notification emails exactly once. Shared by
 * the default `/api/webhook` and the per-provider `/api/webhook/[provider]`
 * routes; `paymentMethod` records which rail settled it (for refund routing).
 * Email failures are swallowed — the order is already saved.
 */
export async function recordPaidWebhookOrder(
  result: WebhookResult,
  origin: string,
  paymentMethod: string,
): Promise<void> {
  const markPending = async () => {
    if (result.settlePendingPaymentId) {
      await markPendingSettled(env.DB, result.settlePendingPaymentId);
    }
  };
  if (result.releaseReservationId) {
    await releaseInventoryReservation(env.DB, result.releaseReservationId);
  }
  if (result.pendingReservationId) {
    await markInventoryReservationPaymentPending(env.DB, result.pendingReservationId);
  }
  if (!result.order) return;

  // Provider metadata carries only a compact reservation id. The authoritative
  // item/price/quantity snapshot stays in D1, avoiding provider metadata limits
  // and ensuring settlement consumes inventory that was atomically held.
  let paidOrder = result.order;
  if (paidOrder.reservationId) {
    const reservedItems = await getActiveReservationItems(env.DB, paidOrder.reservationId);
    if (!reservedItems) {
      // Normal idempotent redelivery after the first delivery settled the
      // reservation. Anything else is a real integrity failure and must retry.
      if (await getOrderByProviderSessionId(env.DB, paidOrder.providerSessionId)) {
        await markPending();
        return;
      }
      throw new Error(`Missing or expired inventory reservation ${paidOrder.reservationId}.`);
    }
    paidOrder = { ...paidOrder, items: reservedItems };
  }

  // recordPaidOrder returns the new id, or null if this session was already
  // recorded (re-delivered webhook) — so emails send exactly once.
  const orderId = await recordPaidOrder(env.DB, { ...paidOrder, paymentMethod });
  if (!orderId) {
    if (await getOrderByProviderSessionId(env.DB, paidOrder.providerSessionId)) {
      await markPending();
      return;
    }
    throw new Error(`Could not settle inventory reservation ${paidOrder.reservationId ?? 'legacy'}.`);
  }
  await markPending();

  const emailer = await getEmailProvider();
  if (!emailer) return;
  const order = await getOrder(env.DB, orderId);
  if (!order) return;

  const items = await listOrderItemsWithImages(env.DB, orderId);
  // Dashboard setting (Settings → Email) wins; falls back to store.config.ts notifyTo.
  const notifyTo = (await getSetting(env.DB, 'email_notify_to')) || getConfig().email.notifyTo;
  const messages = [
    ...(order.email ? [orderConfirmationEmail(order, items, origin)] : []),
    ...(notifyTo ? [orderNotificationEmail(order, items, notifyTo, origin)] : []),
  ];
  for (const msg of messages) {
    try {
      await emailer.send(msg);
    } catch (err) {
      console.error('Order email failed:', err);
    }
  }
}
