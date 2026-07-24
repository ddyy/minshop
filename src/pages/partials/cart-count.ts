import type { APIRoute } from 'astro';
import { cartCount, readCart } from '../../features/cart/cart';

export const prerender = false;

/**
 * The only shopper-specific value in the public storefront shell. Keeping this
 * tiny fragment private lets catalog HTML stay shared at the edge while the
 * complete cart continues to load from /partials/cart only when opened.
 */
export const GET: APIRoute = ({ cookies }) =>
  Response.json(
    { count: cartCount(readCart(cookies)) },
    { headers: { 'cache-control': 'private, no-store' } },
  );
