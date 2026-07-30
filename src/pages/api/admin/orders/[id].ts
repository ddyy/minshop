import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  getOrder,
  getOrderByPublicId,
  fulfillOrder,
  unfulfillOrder,
  type ShippingAddress,
} from '../../../../features/orders/db';
import { getSecret } from '../../../../features/secrets/store';
import { setSetting } from '../../../../features/settings/db';
import {
  carrierCodeFor,
  fetchLabelRates,
  getShipmentRates,
  parseParcelForm,
  purchaseLabel,
  type ShipFrom,
} from '../../../../features/shipping/labels.ts';
import {
  claimPurchase,
  discardLabelAttempt,
  markLabelFailed,
  markLabelUncertain,
  recordPurchased,
  recordQuote,
} from '../../../../features/shipping/labelStore';
import { queueNotification } from '../../../../features/email/outboxStore';
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
import { reissueGuestAccess } from '../../../../features/orders/guestAccess.ts';
import { deliverOrderNotifications } from '../../../../features/email/outbox';
import { getStoreSettings } from '../../../../features/settings/db';
import { shouldSendCustomerOrderEmail } from '../../../../features/email/orderPolicy';
import { getPaymentProvider, type PaymentMethod } from '../../../../features/payments';
import { formatPrice } from '../../../../config';
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

  // ── Shipping labels ────────────────────────────────────────────────────────
  // Buying moves money on the merchant's Shippo account, so every step runs
  // through the shipping_labels state machine: one row per order, conditional
  // claims, and an explicit human gate for ambiguous outcomes. The shipment id
  // is NEVER taken from the request — only from this order's own row.

  if (action === 'label_discard') {
    // The merchant's explicit "I checked the Shippo dashboard" (or abandoning a
    // quote). Cannot touch a purchased row.
    return (await discardLabelAttempt(env.DB, id))
      ? notice('Label attempt discarded. You can fetch rates again.')
      : fail('There is no label attempt to discard.');
  }

  if (action === 'label_rates' || action === 'buy_label') {
    const token = await getSecret(env.DB, 'shippo_api_key');
    if (!token) return fail('Add a Shippo API token in Settings first.');
    if (!existing.ship_address) return fail('This order has no shipping address.');
    let raw: ShippingAddress;
    try {
      raw = JSON.parse(existing.ship_address) as ShippingAddress;
    } catch {
      return fail('This order’s shipping address could not be read.');
    }
    // The snapshot's fields are nullable (provider shapes vary); a label needs
    // the essentials, so refuse with the gap named rather than 500 at Shippo.
    if (!raw.name || !raw.line1 || !raw.city || !raw.postal || !raw.country) {
      return fail(
        'This order’s shipping address is incomplete — a label needs name, street, city, postal code, and country.',
      );
    }
    const shipTo = {
      name: raw.name,
      line1: raw.line1,
      line2: raw.line2,
      city: raw.city,
      state: raw.state,
      postal: raw.postal,
      country: raw.country,
      email: existing.email,
    };

    if (action === 'label_rates') {
      const from: ShipFrom = {
        name: String(form.get('from_name') ?? '').trim(),
        street1: String(form.get('from_street1') ?? '').trim(),
        city: String(form.get('from_city') ?? '').trim(),
        state: String(form.get('from_state') ?? '').trim(),
        zip: String(form.get('from_zip') ?? '').trim(),
        country: String(form.get('from_country') ?? '').trim().toUpperCase(),
      };
      if (!from.name || !from.street1 || !from.city || !from.zip || from.country.length !== 2) {
        return fail('Fill in the complete ship-from address (2-letter country).');
      }
      // Domestic only, for now: an international label needs a customs
      // declaration (contents, values, phone numbers) this flow does not
      // collect, so Shippo would refuse or the parcel would stall at export.
      if (from.country !== shipTo.country.toUpperCase()) {
        return fail(
          `International labels aren’t supported yet (this order ships to ${shipTo.country.toUpperCase()}). Buy this label in your Shippo dashboard, then record the tracking number here.`,
        );
      }
      const settings = await getStoreSettings(env.DB);
      const parsed = parseParcelForm(
        {
          length: String(form.get('parcel_length') ?? ''),
          width: String(form.get('parcel_width') ?? ''),
          height: String(form.get('parcel_height') ?? ''),
          weight: String(form.get('parcel_weight') ?? ''),
        },
        settings.weightUnit,
      );
      if (!parsed.parcel) return fail(parsed.error ?? 'Check the parcel fields.');

      // Remember for next time regardless of whether a label gets bought.
      await setSetting(env.DB, 'ship_from', JSON.stringify(from));
      await setSetting(
        env.DB,
        'parcel_default',
        JSON.stringify({
          length: parsed.parcel.length,
          width: parsed.parcel.width,
          height: parsed.parcel.height,
        }),
      );

      const rates = await fetchLabelRates(
        token,
        from,
        shipTo,
        parsed.parcel,
        settings.weightUnit,
        existing.public_id,
      );
      if (!rates.ok) return fail(rates.error);
      // The quote binds to THIS order in D1. Refusal means a purchase is in
      // progress, done, or the order is no longer labelable (unpaid, fulfilled,
      // pickup) — nothing was charged either way.
      if (!(await recordQuote(env.DB, id, rates.value.shipmentId))) {
        return fail('This order can’t fetch rates right now — a label purchase already exists or the order is no longer eligible.');
      }
      return back;
    }

    // buy_label — the claim flips this order's quote to 'purchasing'; exactly
    // one concurrent submit wins, and the shipment bought from is the row's.
    const rateId = String(form.get('rate') ?? '').trim();
    if (!rateId) return fail('Pick a rate first.');
    const claim = await claimPurchase(env.DB, id, rateId);
    if (!claim) {
      return fail('No open quote to purchase — fetch rates first (or a purchase is already under way).');
    }
    const rates = await getShipmentRates(token, claim.shipmentId);
    if (!rates.ok) {
      await markLabelFailed(env.DB, id, rates.error);
      return fail(rates.error);
    }
    const rate = rates.value.find((r) => r.rateId === rateId);
    if (!rate) {
      await markLabelFailed(env.DB, id, 'Selected rate no longer offered.');
      return fail('That rate is no longer offered. Fetch rates again.');
    }

    const bought = await purchaseLabel(token, rate.rateId, rate.provider, existing.public_id);
    if (!bought.ok) {
      if (bought.uncertain) {
        // The charge MAY have landed. Park it — never auto-retry a purchase —
        // and point the merchant at the dashboard record (tagged with the
        // order id via metadata) before they explicitly discard.
        await markLabelUncertain(env.DB, id, bought.error);
        return fail(
          `Shippo’s answer was lost mid-purchase (${bought.error}) — the label MAY have been bought. Check your Shippo dashboard for order ${existing.public_id}, then discard the attempt if no label exists.`,
        );
      }
      await markLabelFailed(env.DB, id, bought.error);
      return fail(bought.error);
    }

    // One batch: label row, guarded fulfillment, label URL, and the durable
    // shipped-notification row. A crash after the charge can no longer leave a
    // paid label unrecorded, and the email survives via the outbox sweep.
    await recordPurchased(env.DB, id, {
      transactionId: bought.value.transactionId,
      provider: rate.provider,
      service: rate.service,
      amountCents: rate.amountCents,
      trackingNumber: bought.value.trackingNumber,
      labelUrl: bought.value.labelUrl,
      carrierCode: carrierCodeFor(bought.value.provider),
    });
    let delivery = 'No customer email will be sent.';
    const order = await getOrder(env.DB, id);
    if (order?.email && shouldSendCustomerOrderEmail(order.payment_method)) {
      delivery = 'The customer is being emailed the tracking details.';
      try {
        await deliverOrderNotifications(env.DB, id, new URL(request.url).origin);
      } catch (err) {
        // Row stays queued; the piggyback sweep retries it.
        console.error('Shipped-notification delivery failed:', err);
      }
    }
    return notice(
      `Label purchased (${rate.provider} ${rate.service}). Tracking ${bought.value.trackingNumber} recorded. ${delivery}`,
    );
  }

  // Fulfill
  const carrier = String(form.get('carrier') ?? '').trim() || null;
  const trackingNumber = String(form.get('tracking_number') ?? '').trim() || null;
  await fulfillOrder(env.DB, id, carrier, trackingNumber);

  // Durable shipped notice: queue + attempt now; a failed send is retried by
  // the outbox sweep instead of vanishing into a log line. Demo orders and
  // orders without an email are marked skipped by the deliverer itself.
  await queueNotification(env.DB, id, 'order-shipped');
  try {
    await deliverOrderNotifications(env.DB, id, new URL(request.url).origin);
  } catch (err) {
    console.error('Shipped-notification delivery failed:', err);
  }

  return back;
};
