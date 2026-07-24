import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  getOrder,
  fulfillOrder,
  unfulfillOrder,
  recordRefund,
} from '../../../../features/orders/db';
import { getEmailProvider } from '../../../../features/email';
import { orderShippedEmail } from '../../../../features/email/orderConfirmation';
import { shouldSendCustomerOrderEmail } from '../../../../features/email/orderPolicy';
import { getPaymentProvider, type PaymentMethod } from '../../../../features/payments';
import { getConfig } from '../../../../config';
import { getSetting } from '../../../../features/settings/db';

export const prerender = false;

// POST /api/admin/orders/:id — fulfill, unfulfill, or refund.
export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id)) {
    return new Response('Invalid id', { status: 400 });
  }

  const form = await request.formData();
  const action = String(form.get('_action'));
  const back = redirect(`/admin/orders/${id}`, 303);

  if (action === 'unfulfill') {
    await unfulfillOrder(env.DB, id);
    return back;
  }

  if (action === 'refund') {
    const order = await getOrder(env.DB, id);
    if (order?.provider_session_id) {
      // Route to the rail that took the payment (NULL = legacy → store default).
      const provider = await getPaymentProvider((order.payment_method ?? undefined) as PaymentMethod | undefined);
      if (!provider.refund) {
        return redirect(
          `/admin/orders/${id}?error=${encodeURIComponent('Refunds are not supported for this payment method — refund the buyer manually.')}`,
          303,
        );
      }
      try {
        await provider.refund(order.provider_session_id);
        // Full refund (current capability): record the whole order total.
        await recordRefund(env.DB, id, order.amount_total_cents);
      } catch (err) {
        return redirect(
          `/admin/orders/${id}?error=${encodeURIComponent(`Refund failed: ${(err as Error).message}`)}`,
          303,
        );
      }
    }
    return back;
  }

  // Fulfill
  const carrier = String(form.get('carrier') ?? '').trim() || null;
  const trackingNumber = String(form.get('tracking_number') ?? '').trim() || null;
  await fulfillOrder(env.DB, id, carrier, trackingNumber);

  // Demo orders never contact customers. Real orders retain the normal shipping
  // notification, and email failure never blocks fulfillment.
  const order = await getOrder(env.DB, id);
  if (order?.email && shouldSendCustomerOrderEmail(order.payment_method)) {
    const emailer = await getEmailProvider();
    if (emailer) {
      try {
        const storeName = (await getSetting(env.DB, 'store_name')) || getConfig().storeName;
        await emailer.send(orderShippedEmail(order, new URL(request.url).origin, storeName));
      } catch (err) {
        console.error('Shipping email failed:', err);
      }
    }
  }

  return back;
};
