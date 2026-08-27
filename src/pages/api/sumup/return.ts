import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { settleSumUpCheckout } from '../../../features/payments/sumup';
import { getPendingByPublicId } from '../../../features/payments/lightning/pending';
import { recordPaidWebhookOrder } from '../../../features/orders/recordWebhook';
import { getStoreSettings } from '../../../features/settings/db';
import { getSecret } from '../../../features/secrets/store';

export const prerender = false;

/**
 * Customer return from SumUp Hosted Checkout. Re-fetches the checkout (authority),
 * settles when PAID, then redirects to the order confirmation URL.
 */
export const GET: APIRoute = async ({ url }) => {
  const success = url.searchParams.get('success');
  const ref = url.searchParams.get('ref');
  const idParam = url.searchParams.get('id');
  if (!success || new URL(success).origin !== url.origin) {
    return new Response('Invalid SumUp return.', { status: 400 });
  }

  const apiKey = await getSecret(env.DB, 'sumup_api_key');
  const settings = await getStoreSettings(env.DB);
  const merchantCode = settings.sumupMerchantCode;
  if (!apiKey || !merchantCode) {
    return new Response('SumUp is not configured.', { status: 503 });
  }

  let checkoutId = idParam;
  if (!checkoutId && ref) {
    const pending = await getPendingByPublicId(env.DB, ref);
    checkoutId = pending?.payment_hash ?? null;
  }
  if (!checkoutId) {
    return new Response('Missing SumUp checkout id.', { status: 400 });
  }

  try {
    const result = await settleSumUpCheckout(env.DB, { apiKey, merchantCode }, checkoutId);
    await recordPaidWebhookOrder(result, url.origin, 'sumup', settings);
    if (result.type !== 'sumup.paid' || !result.order) {
      return new Response(
        'Payment is not confirmed yet. If you were charged, refresh in a moment or contact the store.',
        { status: 409 },
      );
    }
    return Response.redirect(success, 303);
  } catch (error) {
    console.error('SumUp settle failed:', error);
    return new Response('We could not confirm this payment. Please contact the store.', {
      status: 502,
    });
  }
};
