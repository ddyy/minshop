import { env } from 'cloudflare:workers';
import type { WebhookResult } from '../payments/provider';
import { recordPaidOrder, getOrderByProviderSessionId } from './db';
import { deliverOrderNotifications, sweepStaleNotifications } from '../email/outbox';
import { persistRefundEvent, applyRefundEvent } from '../refunds/sync';
import { sendRefundNotice } from '../refunds/notify';
import { getPaymentProvider, type PaymentMethod } from '../payments';
import type { StoreSettings } from '../settings/db';
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
 *
 * `settings` is optional but every caller already has it (middleware for /pay,
 * an explicit load in the webhook routes). Passing it removes four D1 reads from
 * the settlement path — the whole-table settings scan plus the three individual
 * lookups whose values are already on `StoreSettings`.
 *
 * `waitUntil` (the ExecutionContext's, when the caller has one) moves the whole
 * notification pipeline — provider construction, the order/items reads, both
 * sends — off the response's critical path. Best-effort by design: sends were
 * already swallowed on failure, so backgrounding them weakens nothing the
 * caller could observe. Callers that need delivery attempted before they
 * answer (the provider webhook routes, whose retries are the safety net) simply
 * don't pass it.
 */
export async function recordPaidWebhookOrder(
  result: WebhookResult,
  origin: string,
  paymentMethod: string,
  settings?: StoreSettings,
  waitUntil?: (promise: Promise<unknown>) => void,
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

  // A refund reported by the provider. persistRefundEvent is deliberately NOT
  // wrapped: if we can't even record the event, the caller should 5xx so the
  // provider retries. Everything after it is recoverable from the stored row,
  // so an unmatched or conflicting event still answers 200 rather than making
  // the provider redeliver a valid event forever.
  if (result.refundSync) {
    await persistRefundEvent(env.DB, paymentMethod, result.refundSync);
    // Building the client throws if the rail isn't fully configured. That must
    // not turn a valid, already-persisted event into a 500 and an endless
    // provider retry — without the lookup the event simply stays queued.
    let findSessionIdForPayment;
    try {
      const provider = await getPaymentProvider(paymentMethod as PaymentMethod);
      findSessionIdForPayment = provider.findSessionIdForPayment?.bind(provider);
    } catch (err) {
      console.error('Refund correlation provider unavailable:', err);
    }
    const outcome = await applyRefundEvent(env.DB, paymentMethod, result.refundSync, {
      findSessionIdForPayment,
    });
    if (outcome.status === 'processed') {
      await sendRefundNotice(outcome.orderId, outcome.deltaCents, origin);
    }
    return;
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
      // This is THE redelivery path for reserved checkouts, so it must finish
      // any emails the first delivery left unsent — same as the branch below.
      const settled = await getOrderByProviderSessionId(env.DB, paidOrder.providerSessionId);
      if (settled) {
        await markPending();
        await deliverOrderNotifications(env.DB, settled.id, origin, settings);
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
    const existing = await getOrderByProviderSessionId(env.DB, paidOrder.providerSessionId);
    if (existing) {
      await markPending();
      // The redelivery IS the safety net: if the first delivery recorded the
      // order but died before its emails went out, this retry finishes them.
      // (Previously this path returned with the emails unsent, forever.)
      await deliverOrderNotifications(env.DB, existing.id, origin, settings);
      return;
    }
    throw new Error(`Could not settle inventory reservation ${paidOrder.reservationId ?? 'legacy'}.`);
  }
  // Orders built from a pending payment settle it inside the batch above
  // (settlePaymentHash); the separate round trip is only for results that
  // carry a settle id without one (none today — belt and braces).
  if (!paidOrder.settlePaymentHash) await markPending();

  // The batch above committed the outbox rows with the order; delivery is a
  // separate, repeatable act. A send that fails here stays claimed-then-failed
  // in the outbox and is finished by a webhook redelivery or the sweep — so
  // this call reports outcomes into the outbox instead of throwing. The sweep
  // rides along to drain any OTHER order's stranded rows a little per sale.
  const deliver = async () => {
    await deliverOrderNotifications(env.DB, orderId, origin, settings);
    await sweepStaleNotifications(env.DB, origin);
  };
  if (waitUntil) waitUntil(deliver().catch((err) => console.error('Notification delivery failed:', err)));
  else await deliver();
}
