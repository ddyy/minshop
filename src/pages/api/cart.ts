import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { readCart, writeCart, CART_QTY_MAX } from '../../features/cart/cart';
import { cartKey, parseCartKey } from '../../features/cart/key';
import { getProductByPublicId } from '../../features/products/db';
import { listVariants, getExtrasByPublicIds } from '../../features/products/variants';
import { parsePublicId } from '../../features/ids/publicId.ts';
import { getStoreSettings } from '../../features/settings/db';

export const prerender = false;

// POST /api/cart — add / update / remove a line, then back to the cart.
// Lines are keyed by product[:variant][#extras] public-ID tuples. `add` resolves
// the chosen variant + extras (validated against D1); `update`/`remove` act on
// the line key. Numeric row IDs are never accepted.
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
  const productPublicId = parsePublicId(form.get('product_id'), 'product');
  const product = productPublicId ? await getProductByPublicId(env.DB, productPublicId) : null;
  if (!product || !product.active || !product.public_id) return done();

  // Variant is required when the product has any.
  const variants = await listVariants(env.DB, product.id);
  let variantPublicId: string | null = null;
  if (variants.length > 0) {
    const wanted = parsePublicId(form.get('variant_id'), 'variant');
    const chosen = wanted ? variants.find((v) => v.public_id === wanted) : undefined;
    if (!chosen) {
      if (partial) return new Response(null, { status: 204 });
      const label = product.variant_label || 'option';
      return redirect(
        `/products/${product.slug}?error=${encodeURIComponent(`Please choose a ${label}.`)}`,
        303,
      );
    }
    variantPublicId = chosen.public_id;
  }

  // Extras: keep only valid, active ones that belong to the product.
  const wantExtras = form
    .getAll('extra')
    .map((v) => parsePublicId(v, 'extra'))
    .filter((v): v is string => v !== null);
  const extras = wantExtras.length
    ? await getExtrasByPublicIds(env.DB, product.id, wantExtras)
    : [];

  const key = cartKey(
    product.public_id,
    variantPublicId,
    extras.flatMap((e) => (e.public_id ? [e.public_id] : [])),
  );
  cart[key] = Math.min((cart[key] ?? 0) + 1, CART_QTY_MAX);

  writeCart(cookies, cart, url.protocol === 'https:');
  return done();
};
