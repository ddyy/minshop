import { env } from 'cloudflare:workers';
import {
  markPendingSettled,
  pendingToPaidOrder,
  type PendingPayment,
} from '../lightning/pending';
import { getLightningBackend } from '../lightning';
import { getOrderByProviderSessionId, recordPaidOrder } from '../../orders/db';
import { recordPaidWebhookOrder } from '../../orders/recordWebhook';
import { resolveRequiredOrderEmail } from '../../email/orderPolicy';
import { deliverOrderNotifications } from '../../email/outbox';
import type { StoreSettings } from '../../settings/db';

// Settlement logic for the self-rendered /pay page, one function per method. Kept
// here (beside the views) so the route stays a thin dispatcher.

export interface DemoSettleResult {
  /** True once the order is recorded; the CALLER builds the redirect URL from
   *  its guest param — this module never emits a bare public-id URL. */
  settled?: boolean;
  declined?: string | null;
}

const DECLINE: Record<string, string> = {
  insufficient: 'Payment declined — insufficient funds. (Simulated)',
  decline: 'Payment declined — your card was declined. (Simulated)',
};

/**
 * Handle a demo-checkout POST. "approve" records a genuine order (tagged
 * payment_method='demo') through the same path the real webhooks use — emails,
 * stock, revenue, confirmation — and signals settled so the caller can redirect
 * to its guest order URL. Any other outcome returns a simulated decline message.
 */
export async function settleDemoCheckout(
  pending: PendingPayment,
  form: FormData,
  origin: string,
  settings?: StoreSettings,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<DemoSettleResult> {
  // Fail closed after the demo window even if a POST slips past the page guard.
  if (pending.expires_at != null && Date.parse(pending.expires_at) <= Date.now()) {
    return { declined: 'This demo checkout has expired.' };
  }
  const outcome = String(form.get('outcome') ?? 'approve');
  const email = resolveRequiredOrderEmail(String(form.get('email') ?? ''), pending.email);
  if (!email) return { declined: 'A valid email is required.' };
  if (outcome === 'approve') {
    const order = { ...pendingToPaidOrder(pending), email };
    // pendingToPaidOrder carries settlePaymentHash, so the pending row settles
    // inside the order batch — no separate markPendingSettled round trip. With
    // waitUntil the emails (and their reads) run after the redirect is sent.
    await recordPaidWebhookOrder({ type: 'demo.paid', order }, origin, 'demo', settings, waitUntil);
    return { settled: true };
  }
  return { declined: DECLINE[outcome] ?? DECLINE.decline };
}

/**
 * Settle-on-load for Lightning: poll the node directly (authoritative, so the page
 * works even with no public webhook). Records + marks settled when paid. Returns
 * true once settled so the caller can redirect to the order page.
 */
export async function settleLightningOnLoad(
  pending: PendingPayment,
  origin: string,
  settings?: StoreSettings,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<boolean> {
  let paid = false;
  try {
    const status = await (await getLightningBackend()).getIncoming(pending.payment_hash);
    paid = status.paid;
  } catch {
    // Node unreachable — the page's refresh loop will retry.
  }
  if (!paid) return false;
  const order = pendingToPaidOrder(pending);
  const orderId = await recordPaidOrder(env.DB, order);
  let settledOrderId = orderId;
  if (!orderId) {
    const existing = await getOrderByProviderSessionId(env.DB, order.providerSessionId);
    if (!existing) {
      throw new Error(`Inventory reservation ${pending.public_id} is no longer active.`);
    }
    settledOrderId = existing.id;
    // Won the settlement → the batch already marked the pending row. Lost it
    // (webhook got there first) → that winner's batch marked it; settle again
    // explicitly only in that race, as belt and braces for the redirect check.
    await markPendingSettled(env.DB, pending.payment_hash);
  }
  // This path exists precisely for installations with NO public webhook, so if
  // it doesn't dispatch the outbox rows nothing else reliably will (the sweep
  // needs a later sale). Backgrounded when the page has an execution context.
  const deliver = () => deliverOrderNotifications(env.DB, settledOrderId!, origin, settings);
  if (waitUntil) waitUntil(deliver().catch((err) => console.error('Notification delivery failed:', err)));
  else await deliver();
  return true;
}
