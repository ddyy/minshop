import type { D1Database } from '@cloudflare/workers-types';
import { withPublicId } from '../ids/publicId.ts';

export interface Product {
  id: number;
  public_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  price_cents: number;
  currency: string;
  image_key: string | null;
  stock: number;
  active: number;
  variant_label: string | null; // variant group display name (e.g. "Size"); null = no variants
  /** Packed item weight in grams; NULL = unknown (never "zero" — see 0030). */
  weight_grams: number | null;
  /** 0 = digital/no fulfillment: excluded from shipment weight and from the
   *  missing-weight check, so a mixed cart can still check out. */
  requires_shipping: number;
  /** Precomputed semantic neighbours as a JSON id array; null = not computed yet
   *  (see migration 0024 / features/search relatedIds). */
  related_ids: string | null;
  created_at: string;
}

/** Scalar fields parsed from the product form (image handled separately). */
export interface ProductFields {
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  stock: number;
  active: number;
  weight_grams: number | null;
  requires_shipping: number;
}

/** Full input for create/update — form fields plus resolved image key + slug. */
export interface ProductInput extends ProductFields {
  image_key: string | null;
  slug: string;
}

/** A page of active products for the storefront, newest first. */
export async function listProducts(
  db: D1Database,
  limit: number,
  offset = 0,
  orderBy = 'created_at DESC',
): Promise<Product[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM products WHERE active = 1 ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all<Product>();
  return results ?? [];
}

/** Total active products (for pagination). */
export async function countProducts(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM products WHERE active = 1')
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** A product row plus its lifetime units sold (paid orders only). */
export interface AdminProduct extends Product {
  sold: number;
}

/**
 * A page of all products (including inactive) for the admin view, each with a
 * `sold` count (sum of quantities across paid orders). The correlated subquery
 * keeps `sold` sortable via the same ORDER BY whitelist as the other columns.
 */
/**
 * A prebuilt WHERE clause and its bound values, from features/products/filter.ts.
 * Pass the SAME value to listAllProducts and countAllProducts.
 */
export interface ProductFilter {
  where: string;
  params: string[];
}
const EMPTY_PRODUCT_FILTER: ProductFilter = { where: '', params: [] };

export async function listAllProducts(
  db: D1Database,
  limit: number,
  offset = 0,
  orderBy = 'created_at DESC',
  filter: ProductFilter = EMPTY_PRODUCT_FILTER,
): Promise<AdminProduct[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*,
              COALESCE((
                SELECT SUM(oi.quantity)
                  FROM order_items oi
                  JOIN orders o ON o.id = oi.order_id
                 WHERE oi.product_id = p.id AND o.status = 'paid'
              ), 0) AS sold
         FROM products p
        ${filter.where}
        ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    )
    .bind(...filter.params, limit, offset)
    .all<AdminProduct>();
  return results ?? [];
}

/** Total products including inactive (for admin pagination). */
export async function countAllProducts(
  db: D1Database,
  filter: ProductFilter = EMPTY_PRODUCT_FILTER,
): Promise<number> {
  // Aliased `p` even without a join: the filter fragments are written against
  // the same alias listAllProducts uses, so one clause serves both queries.
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM products p ${filter.where}`)
    .bind(...filter.params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Stable keyset page for catalog-wide background/admin jobs. Unlike the admin
 * table query this does not calculate sales totals, and unlike OFFSET pagination
 * it keeps making progress if rows are removed while a job is running.
 */
export async function listProductsAfterId(
  db: D1Database,
  afterId: number,
  limit: number,
): Promise<Product[]> {
  const { results } = await db
    .prepare('SELECT * FROM products WHERE id > ? ORDER BY id ASC LIMIT ?')
    .bind(afterId, limit)
    .all<Product>();
  return results ?? [];
}

/** Single product by id, or null if missing. */
/**
 * Active products for a list of ids, returned IN THE ORDER of `ids` (so a ranked
 * search — e.g. vector similarity — keeps its ordering). Missing/inactive dropped.
 */
/**
 * Parse the stored `related_ids` JSON. Returns null when it was never computed
 * (so the caller can backfill), or [] when computed and genuinely empty. Never
 * throws — a malformed value is treated as "not computed".
 */
export function parseRelatedIds(raw: string | null): number[] | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((n): n is number => Number.isInteger(n) && n > 0);
  } catch {
    return null;
  }
}

/** Persist a product's precomputed semantic neighbours (see migration 0024). */
export async function setRelatedIds(
  db: D1Database,
  productId: number,
  ids: number[],
): Promise<void> {
  await db
    .prepare('UPDATE products SET related_ids = ? WHERE id = ?')
    .bind(JSON.stringify(ids), productId)
    .run();
}

export async function getProductsByIds(db: D1Database, ids: number[]): Promise<Product[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT * FROM products WHERE id IN (${placeholders}) AND active = 1`)
    .bind(...ids)
    .all<Product>();
  const byId = new Map((results ?? []).map((p) => [p.id, p]));
  return ids.map((id) => byId.get(id)).filter((p): p is Product => p !== undefined);
}

/** Active products for many public IDs in one cart-resolution read. */
export async function getProductsByPublicIds(
  db: D1Database,
  publicIds: string[],
): Promise<Product[]> {
  if (publicIds.length === 0) return [];
  const placeholders = publicIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT * FROM products WHERE public_id IN (${placeholders}) AND active = 1`)
    .bind(...publicIds)
    .all<Product>();
  return results ?? [];
}

export async function getProduct(db: D1Database, id: number): Promise<Product | null> {
  return db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Product>();
}

/** Active products at or below a stock threshold, lowest first (for the dashboard). */
export async function lowStockProducts(
  db: D1Database,
  threshold: number,
  limit = 8,
): Promise<Product[]> {
  const { results } = await db
    .prepare(
      'SELECT * FROM products WHERE active = 1 AND stock <= ? ORDER BY stock ASC, name LIMIT ?',
    )
    .bind(threshold, limit)
    .all<Product>();
  return results ?? [];
}

/** A row in the product image gallery. */
export interface ProductImageRow {
  id: number;
  product_id: number;
  image_key: string;
  position: number;
  alt: string | null;
  public_id: string | null;
}

/** All gallery images for a product, primary-ish first (by position). */
export async function listProductImages(
  db: D1Database,
  productId: number,
): Promise<ProductImageRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY position, id')
    .bind(productId)
    .all<ProductImageRow>();
  return results ?? [];
}

/** Append an image to a product's gallery (next position). */
export async function addProductImage(
  db: D1Database,
  productId: number,
  imageKey: string,
): Promise<void> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM product_images WHERE product_id = ?')
    .bind(productId)
    .first<{ m: number }>();
  await withPublicId('productImage', (publicId) =>
    db
      .prepare('INSERT INTO product_images (product_id, image_key, position, public_id) VALUES (?, ?, ?, ?)')
      .bind(productId, imageKey, (row?.m ?? -1) + 1, publicId)
      .run(),
  );
}

export async function getProductImage(
  db: D1Database,
  imageId: number,
): Promise<ProductImageRow | null> {
  return db.prepare('SELECT * FROM product_images WHERE id = ?').bind(imageId).first<ProductImageRow>();
}

export async function deleteProductImageRow(db: D1Database, imageId: number): Promise<void> {
  await db.prepare('DELETE FROM product_images WHERE id = ?').bind(imageId).run();
}

/** Keep gallery references valid when the legacy single-image update path replaces a key. */
export async function replaceProductImageKey(
  db: D1Database,
  productId: number,
  oldKey: string,
  newKey: string,
): Promise<void> {
  await db
    .prepare(
      'UPDATE product_images SET image_key = ? WHERE product_id = ? AND image_key = ?',
    )
    .bind(newKey, productId, oldKey)
    .run();
}

/** Set an image's alt text (empty string → null). */
export async function setProductImageAlt(
  db: D1Database,
  imageId: number,
  alt: string,
): Promise<void> {
  await db
    .prepare('UPDATE product_images SET alt = ? WHERE id = ?')
    .bind(alt.trim() || null, imageId)
    .run();
}

/** Swap an image's position with its neighbor (no-op at the list boundary). */
export async function moveProductImage(
  db: D1Database,
  imageId: number,
  direction: 'up' | 'down',
): Promise<void> {
  const img = await getProductImage(db, imageId);
  if (!img) return;
  const neighbor =
    direction === 'up'
      ? await db
          .prepare(
            'SELECT * FROM product_images WHERE product_id = ? AND position < ? ORDER BY position DESC LIMIT 1',
          )
          .bind(img.product_id, img.position)
          .first<ProductImageRow>()
      : await db
          .prepare(
            'SELECT * FROM product_images WHERE product_id = ? AND position > ? ORDER BY position ASC LIMIT 1',
          )
          .bind(img.product_id, img.position)
          .first<ProductImageRow>();
  if (!neighbor) return; // already at the top/bottom
  await db.batch([
    db.prepare('UPDATE product_images SET position = ? WHERE id = ?').bind(neighbor.position, img.id),
    db.prepare('UPDATE product_images SET position = ? WHERE id = ?').bind(img.position, neighbor.id),
  ]);
}

/** Set positions to match the given id order (ids not on this product are ignored). */
export async function reorderProductImages(
  db: D1Database,
  productId: number,
  orderedIds: number[],
): Promise<void> {
  const existing = await listProductImages(db, productId);
  const valid = new Set(existing.map((i) => i.id));
  const ids = orderedIds.filter((id) => valid.has(id));
  if (ids.length === 0) return;
  await db.batch(
    ids.map((id, idx) =>
      db
        .prepare('UPDATE product_images SET position = ? WHERE id = ? AND product_id = ?')
        .bind(idx, id, productId),
    ),
  );
}

/** Set a product's primary image key (the denormalized thumbnail). */
export async function setPrimaryImage(
  db: D1Database,
  productId: number,
  imageKey: string | null,
): Promise<void> {
  await db.prepare('UPDATE products SET image_key = ? WHERE id = ?').bind(imageKey, productId).run();
}

/**
 * Keep `products.image_key` in sync with the gallery: the PRIMARY is always the
 * first image (lowest position). Call after any gallery mutation.
 */
export async function syncPrimaryImage(db: D1Database, productId: number): Promise<void> {
  const imgs = await listProductImages(db, productId);
  await setPrimaryImage(db, productId, imgs[0]?.image_key ?? null);
}

/** Move an image to the front of the gallery (→ becomes the primary). */
export async function makeImagePrimary(
  db: D1Database,
  productId: number,
  imageId: number,
): Promise<void> {
  const imgs = await listProductImages(db, productId);
  const newOrder = [imageId, ...imgs.map((i) => i.id).filter((iid) => iid !== imageId)];
  await reorderProductImages(db, productId, newOrder);
  await syncPrimaryImage(db, productId);
}

/** Product by its prefixed public ID (boundary resolution; null if missing). */
export async function getProductByPublicId(db: D1Database, publicId: string): Promise<Product | null> {
  return db.prepare('SELECT * FROM products WHERE public_id = ?').bind(publicId).first<Product>();
}

/** Single product by public slug, or null if missing. */
export async function getProductBySlug(db: D1Database, slug: string): Promise<Product | null> {
  return db.prepare('SELECT * FROM products WHERE slug = ?').bind(slug).first<Product>();
}

/** Insert a product and return its new id (needed for category links). */
export async function createProduct(db: D1Database, p: ProductInput): Promise<number> {
  return withPublicId('product', async (publicId) => {
    const row = await db
      .prepare(
        `INSERT INTO products (name, slug, description, price_cents, currency, image_key, stock, active, weight_grams, requires_shipping, public_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .bind(p.name, p.slug, p.description, p.price_cents, p.currency, p.image_key, p.stock, p.active, p.weight_grams, p.requires_shipping, publicId)
      .first<{ id: number }>();
    return row!.id;
  });
}

export async function updateProduct(db: D1Database, id: number, p: ProductInput): Promise<void> {
  await db
    .prepare(
      `UPDATE products
         SET name = ?, slug = ?, description = ?, price_cents = ?, currency = ?, image_key = ?, stock = ?, active = ?,
             weight_grams = ?, requires_shipping = ?
       WHERE id = ?`,
    )
    .bind(p.name, p.slug, p.description, p.price_cents, p.currency, p.image_key, p.stock, p.active, p.weight_grams, p.requires_shipping, id)
    .run();
}

export async function deleteProduct(db: D1Database, id: number): Promise<void> {
  // Clear category links first (FKs aren't enforced on D1).
  await db.batch([
    db.prepare('DELETE FROM product_categories WHERE product_id = ?').bind(id),
    db.prepare('DELETE FROM product_images WHERE product_id = ?').bind(id),
    db.prepare('DELETE FROM products WHERE id = ?').bind(id),
  ]);
}
