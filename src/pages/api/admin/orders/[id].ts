import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  getOrder,
  fulfillOrder,
  unfulfillOrder,
} from '../../../../features/orders/db';
import {
  recordExternalRefund,
  syncProviderRefund,
  voidRecordedRefund,
  acknowledgeRefundReview,
  refundableCents,
} from '../../../../features/refunds/db';
import { getEmailProvider } from '../../../../features/email';
import {
  orderShippedEmail,
  orderRefundedEmail,
} from '../../../../features/email/orderConfirmation';
import { shouldSendCustomerOrderEmail } from '../../../../features/email/orderPolicy';
import { getPaymentProvider, type PaymentMethod } from '../../../../features/payments';
import { formatPrice, getConfig } from '../../../../config';
import { getSetting } from '../../../../features/settings/db';

export const prerender = false;

/**
 * Tell the customer about a refund just recorded here. Mirrors the webhook
 * path's rules: only the newly recognised amount, never for demo orders, and a
 * failure is logged rather than unwinding accounting that already committed.
 */
async function sendRefundNotice(
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
      orderRefundedEmail(order, deltaCents, order.refunded_cents, origin, storeName),
    );
  } catch (err) {
    console.error('Refund email failed:', err);
  }
}

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

  const fail = (msg: string) =>
    redirect(`/admin/orders/${id}?error=${encodeURIComponent(msg)}`, 303);
  const cents = () => {
    const raw = String(form.get('amount') ?? '').trim();
    // Merchants type dollars; everything downstream is cents.
    const n = Math.round(Number(raw) * 100);
    return Number.isFinite(n) ? n : NaN;
  };
  const admin = String(form.get('_admin') ?? '') || null;
  const note = String(form.get('note') ?? '').trim() || null;
  const reason = String(form.get('reason') ?? '').trim() || null;

  // Refund through the provider. Moves money.
  if (action === 'refund') {
    const order = await getOrder(env.DB, id);
    if (!order?.provider_session_id) return back;

    // Local guards first, before building a provider client: constructing one
    // throws when the rail isn't fully configured, and a request we were going
    // to reject anyway shouldn't surface as a 500 with no explanation.
    //
    // A refund already recorded by hand makes a full provider refund ambiguous:
    // we would be asking the provider for the whole total while part of it has
    // already gone back another way. The merchant should refund the remainder
    // in the provider's own dashboard, which syncs back automatically.
    if (order.external_refunded_cents > 0) {
      return fail(
        'This order already has a manually recorded refund. Issue the remaining amount in your payment provider’s dashboard — it will sync back here automatically.',
      );
    }
    if (refundableCents(order) <= 0) return fail('This order is already fully refunded.');

    try {
      const provider = await getPaymentProvider(
        (order.payment_method ?? undefined) as PaymentMethod | undefined,
      );
      if (!provider.refund) {
        return fail(
          'Refunds are not supported for this payment method — return the money yourself, then use "Record refund".',
        );
      }
      await provider.refund(order.provider_session_id);
    } catch (err) {
      return fail(`Refund failed: ${(err as Error).message}`);
    }
    // Absolute, not additive: the provider now holds the full total. The
    // charge.refunded webhook that follows reports the same number and is
    // therefore a no-op rather than a second refund.
    await syncProviderRefund(env.DB, {
      orderId: id,
      cumulativeRefundedCents: order.amount_total_cents,
      provider: order.payment_method ?? 'stripe',
      idempotencyKey: `admin:provider-refund:${id}:${order.amount_total_cents}`,
      reason: reason ?? 'Full refund issued from minshop',
      createdBy: admin,
    });
    return back;
  }

  // Record money already returned outside the provider. Moves no money.
  if (action === 'record_refund') {
    const order = await getOrder(env.DB, id);
    if (!order) return fail('Order not found.');
    const amount = cents();
    if (!Number.isFinite(amount) || amount <= 0) return fail('Enter a refund amount above zero.');

    const result = await recordExternalRefund(env.DB, {
      orderId: id,
      amountCents: amount,
      // Same order + amount + note submitted twice is a double-click, not two
      // refunds. A merchant who really means two identical refunds can add a
      // distinguishing note.
      idempotencyKey: `manual:${id}:${amount}:${note ?? ''}`,
      kind: order.payment_method === 'demo' ? 'demo' : 'manual_external',
      provider: order.payment_method,
      reason,
      note,
      createdBy: admin,
    });

    if (!result.ok) {
      if (result.reason === 'duplicate') {
        return fail('That refund is already recorded — nothing was changed.');
      }
      if (result.reason === 'insufficient_balance') {
        return fail(
          `That is more than the remaining refundable balance (${formatPrice(refundableCents(order))}).`,
        );
      }
      if (result.reason === 'invalid_amount') return fail('Enter a refund amount above zero.');
      return fail('This order cannot be refunded.');
    }
    // Demo orders never took money, so they never tell a customer about it.
    if (order.payment_method !== 'demo') {
      await sendRefundNotice(id, amount, new URL(request.url).origin);
    }
    return back;
  }

  // Reconcile a refund the merchant made in the provider's own dashboard, for
  // when the webhook never arrived. Absolute: this is the provider's total.
  if (action === 'sync_refund') {
    const order = await getOrder(env.DB, id);
    if (!order) return fail('Order not found.');
    const amount = cents();
    if (!Number.isFinite(amount) || amount < 0) return fail('Enter the total refunded so far.');
    if (amount > order.amount_total_cents) {
      return fail('That is more than the order total.');
    }

    const result = await syncProviderRefund(env.DB, {
      orderId: id,
      cumulativeRefundedCents: amount,
      provider: order.payment_method ?? 'stripe',
      idempotencyKey: `admin:sync:${id}:${amount}`,
      providerRefundId: String(form.get('provider_refund_id') ?? '').trim() || null,
      reason: reason ?? 'Synced by hand from the provider dashboard',
      createdBy: admin,
    });

    if (!result.ok) return fail('This order cannot be reconciled.');
    if (!result.advanced) {
      return fail('That total is already recorded — nothing was changed.');
    }
    await sendRefundNotice(id, result.deltaCents, new URL(request.url).origin);
    return back;
  }

  // Correct a mistaken manual entry. Moves no money.
  if (action === 'void_refund') {
    const refundId = Number(form.get('refund_id'));
    if (!Number.isInteger(refundId)) return fail('Invalid refund.');
    const result = await voidRecordedRefund(env.DB, {
      refundId,
      idempotencyKey: `void:${refundId}`,
      reason,
      createdBy: admin,
    });
    if (!result.ok) {
      return fail(
        result.reason === 'duplicate'
          ? 'That entry has already been voided.'
          : 'Only manually recorded refunds can be voided.',
      );
    }
    return back;
  }

  if (action === 'review_refund') {
    await acknowledgeRefundReview(env.DB, id, admin);
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
