import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { applyRefundEvent } from '../../../features/refunds/sync';
import { listUnmatchedRefundEvents } from '../../../features/refunds/db';
import { getPaymentProvider, type PaymentMethod } from '../../../features/payments';

export const prerender = false;

// POST /api/admin/refunds — reconciliation actions for refund events that
// arrived from a provider but could not be matched to an order.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const action = String(form.get('_action'));
  const back = redirect('/admin/orders', 303);
  const fail = (msg: string) => redirect(`/admin/orders?error=${encodeURIComponent(msg)}`, 303);

  // Retry correlation. Safe to run repeatedly: applyRefundEvent is idempotent
  // on the event id, so a retry that now matches applies once and a retry that
  // still doesn't simply stays queued.
  if (action === 'retry_refund_event') {
    const eventId = String(form.get('event_id') ?? '').trim();
    if (!eventId) return fail('Missing event.');

    const events = await listUnmatchedRefundEvents(env.DB);
    const stored = events.find((e) => e.provider_event_id === eventId);
    if (!stored) return fail('That event is no longer waiting to be reconciled.');

    // Retry runs the same correlation the webhook did, including the provider
    // session lookup — so a merchant clicking Retry after a transient provider
    // failure gets the automatic backfill rather than having to edit the database.
    let findSessionIdForPayment;
    try {
      const provider = await getPaymentProvider(stored.provider as PaymentMethod);
      findSessionIdForPayment = provider.findSessionIdForPayment?.bind(provider);
    } catch {
      // Rail no longer configured — correlate against what's already stored.
    }

    const outcome = await applyRefundEvent(
      env.DB,
      stored.provider,
      {
        eventId: stored.provider_event_id,
        providerPaymentId: stored.provider_payment_id ?? '',
        providerChargeId: stored.provider_charge_id,
        cumulativeRefundedCents: stored.cumulative_refunded_cents,
        currency: stored.currency,
      },
      { findSessionIdForPayment },
    );

    if (outcome.status === 'unmatched') {
      return fail(
        'Still no order matches that payment. It stays queued — you can retry again after the order’s payment ID is filled in.',
      );
    }
    if (outcome.status === 'review') {
      return redirect(`/admin/orders/${outcome.orderId}`, 303);
    }
    return redirect(`/admin/orders/${outcome.orderId}`, 303);
  }

  return back;
};
