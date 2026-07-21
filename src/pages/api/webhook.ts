import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getPaymentProvider, defaultMethod } from '../../features/payments';
import { getStoreSettings } from '../../features/settings/db';
import { recordPaidWebhookOrder } from '../../features/orders/recordWebhook';

export const prerender = false;

// Default-provider payment webhook (the store's primary rail — e.g. Stripe's
// dashboard points here). Additional rails running alongside it post to their own
// path, /api/webhook/<method>, since one endpoint can only verify one signature.
// Provider-agnostic: the provider verifies + normalizes; the helper persists + emails.
export const POST: APIRoute = async ({ request }) => {
  const payload = await request.text();
  const origin = new URL(request.url).origin;
  const method = defaultMethod(await getStoreSettings(env.DB));

  let result;
  try {
    const provider = await getPaymentProvider(method);
    result = await provider.verifyWebhook(payload, request.headers);
  } catch (err) {
    return new Response(`Webhook verification failed: ${(err as Error).message}`, { status: 400 });
  }

  await recordPaidWebhookOrder(result, origin, method);
  return new Response('ok', { status: 200 });
};
