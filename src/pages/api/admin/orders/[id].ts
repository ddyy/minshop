import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  getOrder,
  getOrderByPublicId,
  fulfillOrder,
  unfulfillOrder,
} from '../../../../features/orders/db';
import {
  recordExternalRefund,
  syncProviderRefund,
  voidRecordedRefund,
  acknowledgeRefundReview,
  refundableCents,
  openReviewIfOverRefunded,
  getRefundByPublicId,
} from '../../../../features/refunds/db';
import { sendRefundNotice } from '../../../../features/refunds/notify';
import { getEmailProvider } from '../../../../features/email';
import { orderShippedEmail } from '../../../../features/email/orderConfirmation';
import { guestOrderUrl, reissueGuestAccess } from '../../../../features/orders/guestAccess.ts';
import { deliverOrderNotifications } from '../../../../features/email/outbox';
import { getStoreSettings } from '../../../../features/settings/db';
import { shouldSendCustomerOrderEmail } from '../../../../features/email/orderPolicy';
import { getPaymentProvider, type PaymentMethod } from '../../../../features/payments';
import { formatPrice, getConfig } from '../../../../config';
import { getSetting } from '../../../../features/settings/db';
import { parseOrderOrLegacyPublicId } from '../../../../features/ids/publicId';

export const prerender = false;

// POST /api/admin/orders/:id — fulfill, unfulfill, refund, or reissue the guest
// link. :id is the order public ID (ord_ or a preserved legacy shape); numeric
// row ids are not accepted.
export const POST: APIRoute = async ({ request, params, redirect }) => {
  const publicId = parseOrderOrLegacyPublicId(params.id, 'order');
  const existing = publicId ? await getOrderByPublicId(env.DB, publicId) : null;
  if (!existing) return new Response('Not found', { status: 404 });
  const id = existing.id;

  const form = await request.formData();
  const action = String(form.get('_action'));
  const back = redirect(`/admin/orders/${publicId}`, 303);

  if (action === 'unfulfill') {
    await unfulfillOrder(env.DB, id);
    return back;
  }

  const fail = (msg: string) =>
    redirect(`/admin/orders/${publicId}?error=${encodeURIComponent(msg)}`, 303);
  const notice = (msg: string) =>
    redirect(`/admin/orders/${publicId}?notice=${encodeURIComponent(msg)}`, 303);
  const cents = () => {
    const raw = String(form.get('amount') ?? '').trim();
    // Merchants type dollars; everything downstream is cents.
    const n = Math.round(Number(raw) * 100);
    return Number.isFinite(n) ? n : NaN;
  };
  const admin = String(form.get('_admin') ?? '') || null;
  const note = String(form.get('note') ?? '').trim() || null;
  const reason = String(form.get('reason') ?? '').trim() || null;

  // Rotate the guest access token and email the customer the replacement link.
  // The token itself NEVER appears in admin output — the queued customer email
  // is the only delivery path. Reissue applies to settled orders with a
  // revocable registry token; anything else is refused with a reason.
  if (action === 'reissue_link') {
    if (!existing.email) {
      return fail(
        'This order has no customer email, so a new link cannot be delivered. Nothing was changed.',
      );
    }
    if (!shouldSendCustomerOrderEmail(existing.payment_method)) {
      return fail('Demo orders never email customers, so their link cannot be reissued.');
    }
    if (!existing.public_id?.startsWith('ord_')) {
      // A legacy order's guest link IS its preserved public ID — there is no
      // registry token to rotate.
      return fail('This order predates revocable guest links and cannot be reissued.');
    }
    // Rotation kills every old link the instant it lands, so refuse up front
    // when no email provider could deliver the replacement — otherwise the
    // customer would lose access with nothing on the way.
    if (!(await getEmailProvider(await getStoreSettings(env.DB)))) {
      return fail(
        'Email is not configured, so the replacement link could not be delivered. Nothing was changed.',
      );
    }
    // Atomic: rotates the token AND queues the versioned
    // guest-link-reissue:<generation> notification in one D1 batch; refuses
    // unsettled checkouts (and unknown registry rows).
    const reissued = await reissueGuestAccess(env.DB, existing.public_id);
    if (!reissued) {
      return fail('Only settled orders with a guest link can be reissued.');
    }
    try {
      await deliverOrderNotifications(env.DB, id, new URL(request.url).origin);
    } catch (err) {
      // The row stays queued; the piggyback sweep will retry it.
      console.error('Guest-link reissue delivery failed:', err);
    }
    return notice(
      'The old order links no longer work. A new link is being emailed to the customer.',
    );
  }

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
      // NULL predates payment_method and was always Stripe. Falling through to
      // the store's CURRENT default would send a legacy card refund at whatever
      // rail happens to be configured now.
      const provider = await getPaymentProvider(
        (order.payment_method ?? 'stripe') as PaymentMethod,
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
    const synced = await syncProviderRefund(env.DB, {
      orderId: id,
      cumulativeRefundedCents: order.amount_total_cents,
      provider: order.payment_method ?? 'stripe',
      idempotencyKey: `admin:provider-refund:${id}:${order.amount_total_cents}`,
      reason: reason ?? 'Full refund issued from minshop',
      createdBy: admin,
    });
    // Precisely because that webhook is a no-op, it will not mail the customer
    // either — so this path has to. Whichever of the two recognises the money
    // first sends exactly one notice.
    if (synced.ok && synced.advanced) {
      await sendRefundNotice(id, synced.deltaCents, new URL(request.url).origin);
    }
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
    // sendRefundNotice applies the demo rule itself, so demo orders stay silent.
    await sendRefundNotice(id, amount, new URL(request.url).origin);
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
    // The provider total can be individually valid yet exceed the order once
    // added to what was recorded by hand. The generated aggregate clamps, so
    // without this the conflict would be absorbed silently — the webhook path
    // has always checked, and this path must too.
    const conflict = await openReviewIfOverRefunded(env.DB, id);
    await sendRefundNotice(id, result.deltaCents, new URL(request.url).origin);
    if (conflict) {
      return fail(
        'Recorded, but the provider total plus refunds recorded here now exceeds the order total. Review the refunds on this order.',
      );
    }
    return back;
  }

  // Correct a mistaken manual entry. Moves no money. The form submits the
  // refund's public ID (rfnd_ or a preserved legacy UUID); resolution happens
  // here at the boundary and the ledger write stays integer.
  if (action === 'void_refund') {
    const refundPublicId = parseOrderOrLegacyPublicId(form.get('refund_id'), 'refund');
    const target = refundPublicId ? await getRefundByPublicId(env.DB, refundPublicId) : null;
    if (!target || target.order_id !== id) return fail('Invalid refund.');
    const result = await voidRecordedRefund(env.DB, {
      refundId: target.id,
      idempotencyKey: `void:${target.id}`,
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
        const shipOrigin = new URL(request.url).origin;
        await emailer.send(
          orderShippedEmail(order, shipOrigin, storeName, await guestOrderUrl(env.DB, order.public_id, shipOrigin)),
        );
      } catch (err) {
        console.error('Shipping email failed:', err);
      }
    }
  }

  return back;
};
