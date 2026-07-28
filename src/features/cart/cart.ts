import type { AstroCookies } from 'astro';
import type { D1Database } from '@cloudflare/workers-types';
import { getProductsByPublicIds, type Product } from '../products/db';
import {
  getActiveExtrasByPublicIds,
  getActiveVariantsByPublicIds,
  type ProductVariant,
  type ProductExtra,
} from '../products/variants';
import { parseCartKey, lineUnitPriceCents } from './key';

const COOKIE = 'cart';
/** Script-readable item count (see writeCart). Mirrors COOKIE's lifetime. */
export const COUNT_COOKIE = 'cart_n';
const MAX_QTY = 99;
/**
 * Cookie format version. v2 = public-ID line keys stored as {v: 2, items: {key: qty}}.
 * Pre-cutover cookies were a bare {key: qty} map with numeric keys and have no
 * `v` marker, so they fail the version check and read as an empty cart — the
 * numeric parser is gone for good, not grandfathered.
 */
const CART_VERSION = 2;

/** Cart is a cartKey → quantity map (key encodes product[:variant][#extras]). */
export type Cart = Record<string, number>;

export interface CartLine {
  key: string; // the exact cart key (for update/remove)
  product: Product;
  variant: ProductVariant | null;
  extras: ProductExtra[];
  qty: number;
  unitPriceCents: number; // variant/base + selected extras
  lineTotalCents: number;
  availableStock: number; // variant stock when a variant, else product stock
}

export function readCart(cookies: AstroCookies): Cart {
  const raw = cookies.get(COOKIE);
  if (!raw) return {};
  try {
    const parsed = raw.json() as { v?: unknown; items?: unknown };
    if (!parsed || typeof parsed !== 'object' || parsed.v !== CART_VERSION) return {};
    return sanitize(parsed.items);
  } catch {
    return {};
  }
}

/** Keep only well-formed key→qty pairs, clamped — never trust the cookie. */
function sanitize(obj: unknown): Cart {
  const out: Cart = {};
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const qty = Number(v);
      if (parseCartKey(k) && Number.isInteger(qty) && qty > 0) {
        out[k] = Math.min(qty, MAX_QTY);
      }
    }
  }
  return out;
}

export function writeCart(cookies: AstroCookies, cart: Cart, secure: boolean): void {
  cookies.set(COOKIE, { v: CART_VERSION, items: cart }, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 60 * 60 * 24 * 30,
  });
  // Companion cookie holding ONLY the item count, readable by script so the
  // header badge renders with no request (the cart itself stays httpOnly, so a
  // reader learns "3 items" and nothing else). Written and cleared with the cart,
  // so the two share a lifetime and can't drift the way localStorage would.
  cookies.set(COUNT_COOKIE, String(cartCount(cart)), {
    path: '/',
    httpOnly: false,
    sameSite: 'lax',
    secure,
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearCart(cookies: AstroCookies): void {
  cookies.delete(COOKIE, { path: '/' });
  cookies.delete(COUNT_COOKIE, { path: '/' });
}

export function cartCount(cart: Cart): number {
  return Object.values(cart).reduce((sum, q) => sum + q, 0);
}

/**
 * Resolve cart public IDs against D1 for current name/price/stock, dropping any
 * that are missing or inactive. One batched read per entity type; pricing always
 * comes from the DB, never the cookie.
 */
export async function resolveCart(
  db: D1Database,
  cart: Cart,
): Promise<{ lines: CartLine[]; subtotalCents: number }> {
  const requested = Object.entries(cart).flatMap(([key, qty]) => {
    const parsed = parseCartKey(key);
    return parsed ? [{ key, qty, parsed }] : [];
  });
  if (requested.length === 0) return { lines: [], subtotalCents: 0 };

  const [products, variants, extras] = await Promise.all([
    getProductsByPublicIds(db, [...new Set(requested.map((line) => line.parsed.productPublicId))]),
    getActiveVariantsByPublicIds(
      db,
      requested.flatMap((line) =>
        line.parsed.variantPublicId == null ? [] : [line.parsed.variantPublicId],
      ),
    ),
    getActiveExtrasByPublicIds(
      db,
      requested.flatMap((line) => line.parsed.extraPublicIds),
    ),
  ]);
  const productsByPid = new Map(products.map((product) => [product.public_id, product]));
  const variantsByPid = new Map(variants.map((variant) => [variant.public_id, variant]));
  const extrasByPid = new Map(extras.map((extra) => [extra.public_id, extra]));

  const lines: CartLine[] = [];
  for (const { key, qty, parsed } of requested) {
    const product = productsByPid.get(parsed.productPublicId);
    if (!product) continue;

    // Variant (if the key names one) must exist, be active, and belong here.
    let variant: ProductVariant | null = null;
    if (parsed.variantPublicId) {
      variant = variantsByPid.get(parsed.variantPublicId) ?? null;
      if (!variant || variant.product_id !== product.id) continue;
    }
    // Extras: keep only the active ones that belong to this product.
    const lineExtras = parsed.extraPublicIds
      .map((pid) => extrasByPid.get(pid))
      .filter(
        (extra): extra is ProductExtra =>
          extra !== undefined && extra.product_id === product.id,
      );

    const unitPriceCents = lineUnitPriceCents(product.price_cents, variant, lineExtras);
    lines.push({
      key,
      product,
      variant,
      extras: lineExtras,
      qty,
      unitPriceCents,
      lineTotalCents: unitPriceCents * qty,
      availableStock: variant ? variant.stock : product.stock,
    });
  }
  const subtotalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
  return { lines, subtotalCents };
}

export const CART_QTY_MAX = MAX_QTY;
