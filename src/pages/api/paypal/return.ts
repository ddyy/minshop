import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { capturePayPalOrder } from '../../../features/payments/paypal';
import { recordPaidWebhookOrder } from '../../../features/orders/recordWebhook';
import { getStoreSettings } from '../../../features/settings/db';
import { getSecret } from '../../../features/secrets/store';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const orderId = url.searchParams.get('token');
  const success = url.searchParams.get('success');
  if (!orderId || !success || new URL(success).origin !== url.origin) {
    return new Response('Invalid PayPal return.', { status: 400 });
  }
  const clientId = await getSecret(env.DB, 'paypal_client_id');
  const clientSecret = await getSecret(env.DB, 'paypal_client_secret');
  const webhookId = await getSecret(env.DB, 'paypal_webhook_id');
  if (!clientId || !clientSecret || !webhookId) {
    return new Response('PayPal is not configured.', { status: 503 });
  }
  try {
    const settings = await getStoreSettings(env.DB);
    const result = await capturePayPalOrder(env.DB, {
      clientId,
      clientSecret,
      webhookId,
      apiBase: settings.paypalApiUrl ?? undefined,
    }, orderId);
    await recordPaidWebhookOrder(result, url.origin, 'paypal', settings);
    return Response.redirect(success, 303);
  } catch (error) {
    console.error('PayPal capture failed:', error);
    return new Response('We could not confirm this payment. Please contact the store.', { status: 502 });
  }
};
