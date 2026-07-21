import type { D1Database } from '@cloudflare/workers-types';
import { listProductImages } from './db';
import { toMinorUnits } from '../../money';

/** A purchasable variant (the SKU/inventory unit). A product has 0 or N. */
export interface ProductVariant {
  id: number;
  product_id: number;
  label: string;
  price_cents: number;
  stock: number;
  sku: string | null;
  position: number;
  active: number;
  image_id: number | null; // → product_images.id; NULL = use the gallery primary
}

/** A checkbox add-on: a price delta on top of the line, no stock of its own. */
export interface ProductExtra {
  id: number;
  product_id: number;
  label: string;
  price_delta_cents: number;
  position: number;
  active: number;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Variants for a product, in display order. Active-only unless includeInactive. */
export async function listVariants(
  db: D1Database,
  productId: number,
  includeInactive = false,
): Promise<ProductVariant[]> {
  const where = includeInactive ? '' : ' AND active = 1';
  const { results } = await db
    .prepare(`SELECT * FROM product_variants WHERE product_id = ?${where} ORDER BY position, id`)
    .bind(productId)
    .all<ProductVariant>();
  return results ?? [];
}

/** Extras for a product, in display order. Active-only unless includeInactive. */
export async function listExtras(
  db: D1Database,
  productId: number,
  includeInactive = false,
): Promise<ProductExtra[]> {
  const where = includeInactive ? '' : ' AND active = 1';
  const { results } = await db
    .prepare(`SELECT * FROM product_extras WHERE product_id = ?${where} ORDER BY position, id`)
    .bind(productId)
    .all<ProductExtra>();
  return results ?? [];
}

/** One variant by id (any product), or null. */
export async function getVariant(db: D1Database, id: number): Promise<ProductVariant | null> {
  return db.prepare('SELECT * FROM product_variants WHERE id = ?').bind(id).first<ProductVariant>();
}

/** One extra by id (any product), or null. */
export async function getExtra(db: D1Database, id: number): Promise<ProductExtra | null> {
  return db.prepare('SELECT * FROM product_extras WHERE id = ?').bind(id).first<ProductExtra>();
}

/** Active extras for the given ids that belong to `productId` (drops foreign/inactive). */
export async function getExtrasByIds(
  db: D1Database,
  productId: number,
  ids: number[],
): Promise<ProductExtra[]> {
  if (ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT * FROM product_extras WHERE product_id = ? AND active = 1 AND id IN (${ph}) ORDER BY position, id`,
    )
    .bind(productId, ...ids)
    .all<ProductExtra>();
  return results ?? [];
}

// ── Admin writes ─────────────────────────────────────────────────────────────

/** The variant group's display name on a product (e.g. "Size"); null = none. */
export async function setVariantLabel(
  db: D1Database,
  productId: number,
  label: string | null,
): Promise<void> {
  await db.prepare('UPDATE products SET variant_label = ? WHERE id = ?').bind(label, productId).run();
}

export async function createVariant(
  db: D1Database,
  productId: number,
  v: {
    label: string;
    price_cents: number;
    stock: number;
    sku: string | null;
    image_id?: number | null;
    position?: number;
  },
): Promise<void> {
  // Default position appends to the end of the list (so new rows don't jump up top).
  const position = v.position ?? (await nextPosition(db, 'product_variants', productId));
  await db
    .prepare(
      `INSERT INTO product_variants (product_id, label, price_cents, stock, sku, image_id, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(productId, v.label, v.price_cents, v.stock, v.sku, v.image_id ?? null, position)
    .run();
}

export async function updateVariant(
  db: D1Database,
  id: number,
  v: {
    label: string;
    price_cents: number;
    stock: number;
    sku: string | null;
    image_id?: number | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE product_variants SET label = ?, price_cents = ?, stock = ?, sku = ?, image_id = ? WHERE id = ?`,
    )
    .bind(v.label, v.price_cents, v.stock, v.sku, v.image_id ?? null, id)
    .run();
}

/** Null out any variant that referenced a now-deleted gallery image. */
export async function clearVariantImage(db: D1Database, imageId: number): Promise<void> {
  await db
    .prepare('UPDATE product_variants SET image_id = NULL WHERE image_id = ?')
    .bind(imageId)
    .run();
}

export async function deleteVariant(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM product_variants WHERE id = ?').bind(id).run();
}

export async function createExtra(
  db: D1Database,
  productId: number,
  e: { label: string; price_delta_cents: number; position?: number },
): Promise<void> {
  const position = e.position ?? (await nextPosition(db, 'product_extras', productId));
  await db
    .prepare(
      `INSERT INTO product_extras (product_id, label, price_delta_cents, position)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(productId, e.label, e.price_delta_cents, position)
    .run();
}

/** Next position (MAX+1) for a product's variant/extra list — keeps new rows at the end. */
async function nextPosition(
  db: D1Database,
  table: 'product_variants' | 'product_extras',
  productId: number,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM ${table} WHERE product_id = ?`)
    .bind(productId)
    .first<{ m: number }>();
  return (row?.m ?? -1) + 1;
}

export async function updateExtra(
  db: D1Database,
  id: number,
  e: { label: string; price_delta_cents: number },
): Promise<void> {
  await db
    .prepare('UPDATE product_extras SET label = ?, price_delta_cents = ? WHERE id = ?')
    .bind(e.label, e.price_delta_cents, id)
    .run();
}

export async function deleteExtra(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM product_extras WHERE id = ?').bind(id).run();
}

/**
 * Apply the whole variants + extras editor in one shot (so a single "Save changes"
 * persists everything). Reads parallel array fields posted alongside the product
 * form. Rows are matched positionally; each row always emits every field, so the
 * arrays stay aligned. Empty-`*_id` rows with a non-blank label are CREATES; rows
 * whose id appears in `*_remove` are DELETED; the rest are UPDATES.
 *
 *   variant_group_label                          → the group display name ("Size")
 *   v_id[], v_label[], v_price[], v_stock[],
 *   v_sku[], v_image[]                           → one entry per variant row
 *   v_remove[]                                   → variant ids to delete
 *   e_id[], e_label[], e_price[]                 → one entry per extra row
 *   e_remove[]                                   → extra ids to delete
 *
 * Prices arrive in major units and are scaled to `currency`.
 */
export async function applyVariantForm(
  db: D1Database,
  productId: number,
  form: FormData,
  currency: string,
): Promise<void> {
  const str = (name: string) => form.getAll(name).map((v) => String(v));
  const ids = (name: string) =>
    new Set(form.getAll(name).map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0));
  const price = (s: string) => {
    const n = Number(String(s).trim());
    return Number.isFinite(n) && n > 0 ? toMinorUnits(n, currency) : 0;
  };
  const count = (s: string) => {
    const n = Number(String(s).trim());
    return Number.isInteger(n) && n > 0 ? n : 0;
  };

  // The variant group label (null clears it).
  await setVariantLabel(db, productId, String(form.get('variant_group_label') ?? '').trim() || null);

  // Only allow image links to THIS product's gallery images.
  const galleryIds = new Set((await listProductImages(db, productId)).map((i) => i.id));
  const pickImage = (s: string): number | null => {
    const n = Number(String(s).trim());
    return Number.isInteger(n) && galleryIds.has(n) ? n : null;
  };

  // ── Variants ────────────────────────────────────────────────────────────────
  const vRemove = ids('v_remove');
  for (const vid of vRemove) {
    const v = await getVariant(db, vid);
    if (v && v.product_id === productId) await deleteVariant(db, vid);
  }
  const vIds = str('v_id');
  const vLabels = str('v_label');
  const vPrices = str('v_price');
  const vStocks = str('v_stock');
  const vSkus = str('v_sku');
  const vImages = str('v_image');
  for (let i = 0; i < vLabels.length; i++) {
    const id = Number(vIds[i]);
    const label = (vLabels[i] ?? '').trim();
    if (Number.isInteger(id) && vRemove.has(id)) continue; // already deleted
    const fields = {
      label,
      price_cents: price(vPrices[i] ?? ''),
      stock: count(vStocks[i] ?? ''),
      sku: (vSkus[i] ?? '').trim() || null,
      image_id: pickImage(vImages[i] ?? ''),
    };
    if (Number.isInteger(id) && id > 0) {
      if (!label) continue; // a cleared label on an existing row → ignore (use Remove to delete)
      const v = await getVariant(db, id);
      if (v && v.product_id === productId) await updateVariant(db, id, fields);
    } else if (label) {
      await createVariant(db, productId, fields);
    }
  }

  // ── Extras ──────────────────────────────────────────────────────────────────
  const eRemove = ids('e_remove');
  for (const eid of eRemove) {
    const e = await getExtra(db, eid);
    if (e && e.product_id === productId) await deleteExtra(db, eid);
  }
  const eIds = str('e_id');
  const eLabels = str('e_label');
  const ePrices = str('e_price');
  for (let i = 0; i < eLabels.length; i++) {
    const id = Number(eIds[i]);
    const label = (eLabels[i] ?? '').trim();
    if (Number.isInteger(id) && eRemove.has(id)) continue;
    const fields = { label, price_delta_cents: price(ePrices[i] ?? '') };
    if (Number.isInteger(id) && id > 0) {
      if (!label) continue;
      const e = await getExtra(db, id);
      if (e && e.product_id === productId) await updateExtra(db, id, fields);
    } else if (label) {
      await createExtra(db, productId, fields);
    }
  }
}

/** Decrement a variant's stock (clamped at 0) — the variant is the inventory unit. */
export async function decrementVariantStock(
  db: D1Database,
  variantId: number,
  qty: number,
): Promise<void> {
  await db
    .prepare('UPDATE product_variants SET stock = MAX(0, stock - ?) WHERE id = ?')
    .bind(qty, variantId)
    .run();
}
