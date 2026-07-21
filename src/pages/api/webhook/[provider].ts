import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  getPaymentProvider,
  isMethodAvailable,
  type PaymentMethod,
} from '../../../features/payments';
import { getStoreSettings } from '../../../features/settings/db';
import { recordPaidWebhookOrder } from '../../../features/orders/recordWebhook';

export const prerender = false;

const METHODS: PaymentMethod[] = ['stripe', 'lightning', 'opennode'];

// Per-provider webhook: POST /api/webhook/<method>. Lets multiple rails run at
// once — each posts to its OWN path, because a single endpoint can only verify
// one provider's signature. Point each provider's webhook config at its path
// (Stripe dashboard → /api/webhook/stripe, the Lightning mint → /api/webhook/lightning).
export const POST: APIRoute = async ({ request, params }) => {
  const method = params.provider as PaymentMethod;
  const settings = await getStoreSettings(env.DB);
  if (!METHODS.includes(method) || !isMethodAvailable(method, settings)) {
    return new Response('Unknown or unconfigured payment method', { status: 404 });
  }

  const payload = await request.text();
  const origin = new URL(request.url).origin;

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
