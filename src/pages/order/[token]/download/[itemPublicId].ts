import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { isAccessToken } from '../../../../features/ids/token.ts';
import { parsePublicId } from '../../../../features/ids/publicId.ts';
import { resolveAccessToken } from '../../../../features/orders/guestAccess.ts';
import { getOrderByPublicId } from '../../../../features/orders/db.ts';
import { getFileStorage } from '../../../../features/storage/index.ts';

export const prerender = false;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-expose-headers': 'content-disposition, content-type',
};
const PRIVATE_HEADERS = {
  ...CORS,
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
};

export const OPTIONS: APIRoute = () => new Response(null, { status: 204, headers: PRIVATE_HEADERS });

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export const GET: APIRoute = async ({ params }) => {
  const token = params.token;
  const itemPublicId = parsePublicId(params.itemPublicId, 'orderItem');
  if (!token || !isAccessToken(token) || !itemPublicId) return new Response('Not found', { status: 404, headers: PRIVATE_HEADERS });
  const access = await resolveAccessToken(env.DB, token);
  if (!access) return new Response('Not found', { status: 404, headers: PRIVATE_HEADERS });
  const order = access ? await getOrderByPublicId(env.DB, access.order_public_id) : null;
  if (!order) return new Response('Payment is not settled.', { status: 403, headers: PRIVATE_HEADERS });
  if (order.refunded_cents >= order.amount_total_cents) {
    return new Response('Downloads are unavailable for a fully refunded order.', { status: 403, headers: PRIVATE_HEADERS });
  }
  const item = await env.DB
    .prepare(
      `SELECT oi.id, oi.file_key, oi.file_name, oi.file_mime
         FROM order_items oi
        WHERE oi.order_id = ? AND oi.public_id = ? AND oi.file_key IS NOT NULL`,
    )
    .bind(order.id, itemPublicId)
    .first<{ id: number; file_key: string; file_name: string | null; file_mime: string | null }>();
  if (!item) return new Response('Not found', { status: 404, headers: PRIVATE_HEADERS });
  const stored = await getFileStorage().get(item.file_key);
  if (!stored) return new Response('File unavailable', { status: 404, headers: PRIVATE_HEADERS });
  await env.DB.prepare('UPDATE order_items SET downloads = downloads + 1 WHERE id = ?').bind(item.id).run();
  return new Response(stored.body, {
    headers: {
      ...PRIVATE_HEADERS,
      'content-type': item.file_mime ?? stored.contentType,
      'x-content-type-options': 'nosniff',
      'content-disposition': contentDisposition(item.file_name ?? 'download'),
    },
  });
};
