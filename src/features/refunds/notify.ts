import { env } from 'cloudflare:workers';
import { getOrder } from '../orders/db';
import { getEmailProvider } from '../email';
import { orderRefundedEmail } from '../email/orderConfirmation';
import { guestOrderUrl } from '../orders/guestAccess.ts';
import { shouldSendCustomerOrderEmail } from '../email/orderPolicy';
import { getConfig } from '../../config';
import { getSetting } from '../settings/db';

/**
 * Tell the customer about a refund we just recognised.
 *
 * Shared by every path that can advance a refund total — the provider webhook,
 * the admin actions, and the reconciliation retry — because "who sends the
 * email" is precisely the thing that goes wrong when each path keeps its own
 * copy: a minshop-initiated refund whose webhook is a deliberate no-op, or a
 * retry that finally applies a refund, must still mail exactly once.
 *
 * Rules, in one place:
 *  - Only when the total actually ADVANCED, and only for that delta — so a
 *    replay (which advances nothing) is silent and successive partials read as
 *    distinct amounts rather than one growing number.
 *  - Never for demo orders; they never took money.
 *  - A send failure is logged, never propagated: the accounting has committed
 *    and must not be unwound by a mail problem.
 */
export async function sendRefundNotice(
  orderId: number,
  deltaCents: number,
  origin: string,
): Promise<void> {
  if (deltaCents <= 0) return;
  const order = await getOrder(env.DB, orderId);
  if (!order?.email) return;
  if (!shouldSendCustomerOrderEmail(order.payment_method)) return;
  const emailer = await getEmailProvider();
  if (!emailer) return;
  try {
    const storeName = (await getSetting(env.DB, 'store_name')) || getConfig().storeName;
    await emailer.send(
      orderRefundedEmail(order, deltaCents, order.refunded_cents, storeName,
        await guestOrderUrl(env.DB, order.public_id, origin)),
    );
  } catch (err) {
    console.error('Refund email failed:', err);
  }
}
