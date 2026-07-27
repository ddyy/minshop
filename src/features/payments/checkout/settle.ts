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
import type { StoreSettings } from '../../settings/db';

// Settlement logic for the self-rendered /pay page, one function per method. Kept
// here (beside the views) so the route stays a thin dispatcher.

export interface DemoSettleResult {
  redirect?: string;
  declined?: string | null;
}

const DECLINE: Record<string, string> = {
  insufficient: 'Payment declined — insufficient funds. (Simulated)',
  decline: 'Payment declined — your card was declined. (Simulated)',
};

/**
 * Handle a demo-checkout POST. "approve" records a genuine order (tagged
 * payment_method='demo') through the same path the real webhooks use — emails,
 * stock, revenue, confirmation — and returns a redirect to the order page. Any
 * other outcome returns a simulated decline message.
 */
export async function settleDemoCheckout(
  pending: PendingPayment,
  form: FormData,
  origin: string,
  settings?: StoreSettings,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<DemoSettleResult> {
  const outcome = String(form.get('outcome') ?? 'approve');
  const email = resolveRequiredOrderEmail(String(form.get('email') ?? ''), pending.email);
  if (!email) return { declined: 'A valid email is required.' };
  if (outcome === 'approve') {
    const order = { ...pendingToPaidOrder(pending), email };
    // pendingToPaidOrder carries settlePaymentHash, so the pending row settles
    // inside the order batch — no separate markPendingSettled round trip. With
    // waitUntil the emails (and their reads) run after the redirect is sent.
    await recordPaidWebhookOrder({ type: 'demo.paid', order }, origin, 'demo', settings, waitUntil);
    return { redirect: `/order/${pending.public_id}` };
  }
  return { declined: DECLINE[outcome] ?? DECLINE.decline };
}

/**
 * Settle-on-load for Lightning: poll the node directly (authoritative, so the page
 * works even with no public webhook). Records + marks settled when paid. Returns
 * true once settled so the caller can redirect to the order page.
 */
export async function settleLightningOnLoad(pending: PendingPayment): Promise<boolean> {
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
  if (!orderId && !(await getOrderByProviderSessionId(env.DB, order.providerSessionId))) {
    throw new Error(`Inventory reservation ${pending.public_id} is no longer active.`);
  }
  // Won the settlement → the batch already marked the pending row. Lost it
  // (webhook got there first) → that winner's batch marked it; settle again
  // explicitly only in that race, as belt and braces for the redirect check.
  if (!orderId) await markPendingSettled(env.DB, pending.payment_hash);
  return true;
}
