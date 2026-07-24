import type { AstroCookies } from 'astro';
import type { D1Database } from '@cloudflare/workers-types';
import { getProductsByIds, type Product } from '../products/db';
import {
  getActiveExtrasByIds,
  getActiveVariantsByIds,
  type ProductVariant,
  type ProductExtra,
} from '../products/variants';
import { parseCartKey, lineUnitPriceCents } from './key';

const COOKIE = 'cart';
const MAX_QTY = 99;

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
    return sanitize(raw.json());
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
  cookies.set(COOKIE, cart, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearCart(cookies: AstroCookies): void {
  cookies.delete(COOKIE, { path: '/' });
}

export function cartCount(cart: Cart): number {
  return Object.values(cart).reduce((sum, q) => sum + q, 0);
}

/**
 * Resolve cart ids against D1 for current name/price/stock, dropping any that
 * are missing or inactive. Pricing always comes from the DB, never the cookie.
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
    getProductsByIds(db, [...new Set(requested.map((line) => line.parsed.productId))]),
    getActiveVariantsByIds(
      db,
      requested.flatMap((line) =>
        line.parsed.variantId == null ? [] : [line.parsed.variantId],
      ),
    ),
    getActiveExtrasByIds(
      db,
      requested.flatMap((line) => line.parsed.extraIds),
    ),
  ]);
  const productsById = new Map(products.map((product) => [product.id, product]));
  const variantsById = new Map(variants.map((variant) => [variant.id, variant]));
  const extrasById = new Map(extras.map((extra) => [extra.id, extra]));

  const lines: CartLine[] = [];
  for (const { key, qty, parsed } of requested) {
    const product = productsById.get(parsed.productId);
    if (!product) continue;

    // Variant (if the key names one) must exist, be active, and belong here.
    let variant: ProductVariant | null = null;
    if (parsed.variantId) {
      variant = variantsById.get(parsed.variantId) ?? null;
      if (!variant || variant.product_id !== product.id) continue;
    }
    // Extras: keep only the active ones that belong to this product.
    const lineExtras = parsed.extraIds
      .map((id) => extrasById.get(id))
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
