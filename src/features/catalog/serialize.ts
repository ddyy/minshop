import type { Product } from '../products/db';
import type { ProductVariant, ProductExtra } from '../products/variants';
import { productImageUrl } from '../products/image';
import { toMajorUnits } from '../../money';

/** A purchasable variant in catalog form (price in both major + minor units). */
export interface CatalogVariant {
  id: number;
  label: string;
  price: { amount: number; cents: number; currency: string };
  in_stock: boolean;
  stock: number;
  sku: string | null;
}

/** A checkbox add-on in catalog form — a price delta layered on the line. */
export interface CatalogExtra {
  id: number;
  label: string;
  price_delta: { amount: number; cents: number; currency: string };
}

/**
 * The public, machine-readable shape of a product — what the `/api/products`
 * catalog endpoints return for agents/tools. Stable, self-describing, with
 * ABSOLUTE urls so a consumer needs no base-url knowledge. Pure (no bindings) so
 * it's unit-testable and reusable across the list + detail routes.
 *
 * `variant_label` flags products that have a variant group (so a list consumer
 * knows to fetch the detail). `variants`/`extras` are populated only on the
 * detail route — the list stays lightweight.
 */
export interface CatalogProduct {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  price: { amount: number; cents: number; currency: string };
  in_stock: boolean;
  stock: number;
  variant_label: string | null;
  categories: string[];
  image: string;
  url: string;
  variants?: CatalogVariant[];
  extras?: CatalogExtra[];
}

const money = (cents: number, currency: string) => ({
  amount: toMajorUnits(cents, currency), // major units (e.g. 24.0)
  cents, // minor units (Stripe-style)
  currency: currency.toUpperCase(),
});

/**
 * Serialize a product (+ its category names) into the catalog shape. Pass
 * `options.variants`/`options.extras` (detail route) to embed them; when variants
 * are present they are the inventory unit, so top-level stock/in_stock derive from
 * them rather than the product row.
 */
export function toCatalogProduct(
  p: Product,
  categoryNames: string[],
  origin: string,
  options?: { variants?: ProductVariant[]; extras?: ProductExtra[] },
): CatalogProduct {
  const variants = options?.variants;
  const extras = options?.extras;
  const hasVariants = !!variants && variants.length > 0;

  const out: CatalogProduct = {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    price: money(p.price_cents, p.currency),
    // With variants, availability comes from them (the variant is the SKU).
    in_stock: hasVariants ? variants!.some((v) => v.stock > 0) : p.stock > 0,
    stock: hasVariants ? variants!.reduce((n, v) => n + v.stock, 0) : p.stock,
    variant_label: p.variant_label,
    categories: categoryNames,
    image: new URL(productImageUrl(p.image_key), origin).href,
    url: new URL(`/product/${p.slug}`, origin).href,
  };

  if (variants) {
    out.variants = variants.map((v) => ({
      id: v.id,
      label: v.label,
      price: money(v.price_cents, p.currency),
      in_stock: v.stock > 0,
      stock: v.stock,
      sku: v.sku,
    }));
  }
  if (extras) {
    out.extras = extras.map((e) => ({
      id: e.id,
      label: e.label,
      price_delta: money(e.price_delta_cents, p.currency),
    }));
  }
  return out;
}
