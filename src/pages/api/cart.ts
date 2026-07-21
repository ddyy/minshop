import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { readCart, writeCart, CART_QTY_MAX } from '../../features/cart/cart';
import { cartKey, parseCartKey } from '../../features/cart/key';
import { getProduct } from '../../features/products/db';
import { listVariants, getExtrasByIds } from '../../features/products/variants';
import { getStoreSettings } from '../../features/settings/db';

export const prerender = false;

// POST /api/cart — add / update / remove a line, then back to the cart.
// Lines are keyed by product[:variant][#extras]. `add` resolves the chosen
// variant + extras (validated against D1); `update`/`remove` act on the line key.
export const POST: APIRoute = async ({ request, cookies, url, redirect }) => {
  const form = await request.formData();
  const action = String(form.get('_action'));
  const cart = readCart(cookies);
  const partial = request.headers.get('x-partial') === '1';
  // Cart switched off in Settings → browse-only; refuse all cart mutations.
  if (!(await getStoreSettings(env.DB)).cartEnabled) {
    return partial ? new Response(null, { status: 204 }) : redirect('/', 303);
  }
  const done = () =>
    partial ? new Response(null, { status: 204 }) : redirect('/cart', 303);

  // ── update / remove: operate on the exact line key ──────────────────────────
  if (action === 'update' || action === 'remove') {
    const key = String(form.get('key') ?? '');
    if (parseCartKey(key)) {
      if (action === 'remove') {
        delete cart[key];
      } else {
        const qty = Number(form.get('qty'));
        if (Number.isInteger(qty) && qty > 0) cart[key] = Math.min(qty, CART_QTY_MAX);
        else delete cart[key];
      }
    }
    writeCart(cookies, cart, url.protocol === 'https:');
    return done();
  }

  // ── add: product + (required) variant + (optional) extras ───────────────────
  const id = Number(form.get('product_id'));
  const product = Number.isInteger(id) && id > 0 ? await getProduct(env.DB, id) : null;
  if (!product || !product.active) return done();

  // Variant is required when the product has any.
  const variants = await listVariants(env.DB, id);
  let variantId: number | null = null;
  if (variants.length > 0) {
    const chosen = variants.find((v) => v.id === Number(form.get('variant_id')));
    if (!chosen) {
      if (partial) return new Response(null, { status: 204 });
      const label = product.variant_label || 'option';
      return redirect(
        `/product/${product.slug}?error=${encodeURIComponent(`Please choose a ${label}.`)}`,
        303,
      );
    }
    variantId = chosen.id;
  }

  // Extras: keep only valid, active ones that belong to the product.
  const rawExtraIds = form
    .getAll('extra')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  const extras = rawExtraIds.length ? await getExtrasByIds(env.DB, id, rawExtraIds) : [];

  const key = cartKey(id, variantId, extras.map((e) => e.id));
  cart[key] = Math.min((cart[key] ?? 0) + 1, CART_QTY_MAX);

  writeCart(cookies, cart, url.protocol === 'https:');
  return done();
};
