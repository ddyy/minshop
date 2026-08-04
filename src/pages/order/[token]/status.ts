import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { isAccessToken } from '../../../features/ids/token.ts';
import { resolveAccessToken } from '../../../features/orders/guestAccess.ts';
import { getOrderByPublicId, listOrderItems } from '../../../features/orders/db.ts';
import {
  expireSelfRenderedReservation,
  getReservationStatusSnapshot,
} from '../../../features/orders/reservations.ts';
import { purgeStockProductCache } from '../../../features/cache/purge.ts';

export const prerender = false;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const headers = {
  ...CORS,
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
};

export const OPTIONS: APIRoute = () =>
  new Response(null, { status: 204, headers: { ...CORS, 'cache-control': 'private, no-store' } });

export const GET: APIRoute = async ({ params, request }) => {
  const token = params.token;
  if (!token || !isAccessToken(token)) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
  }
  const access = await resolveAccessToken(env.DB, token);
  if (!access) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });

  const order = await getOrderByPublicId(env.DB, access.order_public_id);
  if (order) {
    const items = await listOrderItems(env.DB, order.id);
    const fullyRefunded = order.refunded_cents >= order.amount_total_cents;
    const base = new URL(request.url).origin;
    return new Response(
      JSON.stringify({
        status: fullyRefunded ? 'refunded' : 'paid',
        order_id: order.public_id,
        currency: order.currency.toUpperCase(),
        items: items.map((item) => ({
          ...(item.public_id ? { item_public_id: item.public_id } : {}),
          name: item.name,
          quantity: item.quantity,
          price_cents: item.price_cents,
          ...(!fullyRefunded && item.public_id && item.file_key
            ? { download_url: `${base}/order/${token}/download/${item.public_id}` }
            : {}),
        })),
      }),
      { status: 200, headers },
    );
  }

  if (access.hidden_at) {
    return new Response(JSON.stringify({ error: 'Checkout status is no longer visible.' }), {
      status: 410,
      headers,
    });
  }
  await expireSelfRenderedReservation(env.DB, access.order_public_id, purgeStockProductCache);
  const reservation = await getReservationStatusSnapshot(env.DB, access.order_public_id);
  if (!reservation || reservation.status === 'settled') {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
  }
  if (reservation.status === 'released') {
    return new Response(JSON.stringify({ error: 'Checkout is no longer payable.' }), {
      status: 410,
      headers,
    });
  }
  const status = reservation.status === 'expired' || reservation.status === 'failed' ? 'expired' : 'confirming';
  return new Response(
    JSON.stringify({
      status,
      order_id: access.order_public_id,
      items: reservation.items.map((item) => ({
        ...(item.publicId ? { item_public_id: item.publicId } : {}),
        name: item.name,
        quantity: item.quantity,
        price_cents: item.priceCents,
      })),
    }),
    { status: 200, headers },
  );
};
