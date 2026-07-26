import type { D1Database } from '@cloudflare/workers-types';

export interface Media {
  id: number;
  image_key: string;
  original_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  /** Pixel dimensions, so <img> can reserve its space. NULL for rows created
   *  before migration 0029, and for anything whose header could not be read. */
  width: number | null;
  height: number | null;
  created_at: string;
}

/** Grid/picker page size. Bounds both the admin page and the JSON API. */
export const MEDIA_PAGE_SIZE = 48;

export async function getMedia(db: D1Database, id: number): Promise<Media | null> {
  return db.prepare('SELECT * FROM media WHERE id = ?').bind(id).first<Media>();
}

export async function getMediaByKey(db: D1Database, key: string): Promise<Media | null> {
  return db.prepare('SELECT * FROM media WHERE image_key = ?').bind(key).first<Media>();
}

/** Newest first, matching the media_created index so pagination is stable. */
export async function listMedia(
  db: D1Database,
  limit: number,
  offset: number,
): Promise<Media[]> {
  const { results } = await db
    .prepare('SELECT * FROM media ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
    .bind(limit, offset)
    .all<Media>();
  return results ?? [];
}

export async function countMedia(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS c FROM media').first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * D1 rejects a statement with more than 100 bound parameters ("too many SQL
 * variables"), so anything driven by user content — a page body can reference
 * any number of images — has to be chunked rather than trusted to be small.
 */
const MAX_BOUND_PARAMS = 90; // headroom under D1's hard limit of 100

/** Resolve media rows for a set of keys (used when parsing Markdown bodies). */
export async function findMediaByKeys(db: D1Database, keys: string[]): Promise<Media[]> {
  if (keys.length === 0) return [];
  const found: Media[] = [];
  for (let i = 0; i < keys.length; i += MAX_BOUND_PARAMS) {
    const chunk = keys.slice(i, i + MAX_BOUND_PARAMS);
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await db
      .prepare(`SELECT * FROM media WHERE image_key IN (${placeholders})`)
      .bind(...chunk)
      .all<Media>();
    if (results) found.push(...results);
  }
  return found;
}

export async function createMediaRecord(
  db: D1Database,
  fields: {
    image_key: string;
    original_name: string;
    mime_type: string | null;
    size_bytes: number | null;
    width?: number | null;
    height?: number | null;
  },
): Promise<Media> {
  const row = await db
    .prepare(
      `INSERT INTO media (image_key, original_name, mime_type, size_bytes, width, height)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      fields.image_key,
      fields.original_name,
      fields.mime_type,
      fields.size_bytes,
      fields.width ?? null,
      fields.height ?? null,
    )
    .first<Media>();
  if (!row) throw new Error('media insert returned no row');
  return row;
}

/**
 * Delete a media row ONLY while nothing references it, in one statement.
 *
 * Every usage condition is repeated inside the DELETE rather than checked first,
 * because a check-then-delete leaves a window where an association is created
 * between the two. Single statements are atomic, so an association write racing
 * this either commits first (and NOT EXISTS sees it, refusing) or loses (and its
 * own guard finds no media row). Neither order can produce a dangling reference.
 *
 * Returns the deleted key, or null when the row was referenced or already gone —
 * the caller resolves which for the error message.
 */
export async function deleteMediaRecord(
  db: D1Database,
  id: number,
): Promise<string | null> {
  const row = await db
    .prepare(
      `DELETE FROM media
        WHERE id = ?1
          AND NOT EXISTS (
            SELECT 1 FROM product_images WHERE product_images.image_key = media.image_key
          )
          AND NOT EXISTS (
            SELECT 1 FROM products WHERE products.image_key = media.image_key
          )
          AND NOT EXISTS (
            SELECT 1 FROM page_media WHERE page_media.media_id = media.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM settings
             WHERE settings.key = 'logo_image_key' AND settings.value = media.image_key
          )
        RETURNING image_key`,
    )
    .bind(id)
    .first<{ image_key: string }>();
  return row?.image_key ?? null;
}

export type AttachResult =
  | { ok: true; imageKey: string }
  | { ok: false; error: string };

/**
 * Append a media item to a product's gallery, guarded on the media row still
 * existing and on the product not already holding that key.
 *
 * Both conditions live inside the INSERT for the same reason the delete is
 * guarded: a media row is deletable right up until an association exists, so a
 * separate existence check could pass and then be invalidated. This is used by
 * the upload paths too — a just-created row is unreferenced, and therefore
 * deletable, until this lands.
 */
export async function attachMediaToProduct(
  db: D1Database,
  productId: number,
  mediaId: number,
): Promise<AttachResult> {
  const row = await db
    .prepare(
      `INSERT INTO product_images (product_id, image_key, position)
       SELECT ?1,
              m.image_key,
              (SELECT COALESCE(MAX(position), -1) + 1
                 FROM product_images WHERE product_id = ?1)
         FROM media m
        WHERE m.id = ?2
          AND NOT EXISTS (
            SELECT 1 FROM product_images pi
             WHERE pi.product_id = ?1 AND pi.image_key = m.image_key
          )
       RETURNING image_key`,
    )
    .bind(productId, mediaId)
    .first<{ image_key: string }>();

  if (row) return { ok: true, imageKey: row.image_key };

  // Nothing inserted — say which of the two guards refused.
  const media = await getMedia(db, mediaId);
  return media
    ? { ok: false, error: 'That image is already in this product’s gallery.' }
    : { ok: false, error: 'That image is no longer in the media library.' };
}

/**
 * Statements that replace a page's media associations. Returned rather than
 * executed so the caller can put them in the SAME batch as the page update:
 * D1 batches are atomic, so the claims and the publish decision either both
 * land or neither does. Executing them separately leaves a window where media
 * is deleted after the claim check but before the page is published.
 */
/**
 * Dimensions for the media a page embeds, keyed by image_key.
 *
 * Joined through page_media rather than parsing the body again: the claim rows
 * already record exactly which media a page uses, and one indexed read is
 * cheaper than re-walking the Markdown. Bounded by the page's own claims.
 */
export async function pageImageDimensions(
  db: D1Database,
  pageId: number,
): Promise<Map<string, { width: number; height: number }>> {
  const { results } = await db
    .prepare(
      `SELECT m.image_key, m.width, m.height
         FROM page_media pm JOIN media m ON m.id = pm.media_id
        WHERE pm.page_id = ? AND m.width IS NOT NULL AND m.height IS NOT NULL`,
    )
    .bind(pageId)
    .all<{ image_key: string; width: number; height: number }>();
  return new Map((results ?? []).map((r) => [r.image_key, { width: r.width, height: r.height }]));
}

export function pageMediaClaimStatements(
  db: D1Database,
  pageId: number,
  mediaIds: number[],
): D1PreparedStatement[] {
  const statements = [db.prepare('DELETE FROM page_media WHERE page_id = ?').bind(pageId)];

  // One statement per CHUNK, not per image. D1 allows only 50 queries per
  // Worker invocation on the Free plan, and a save already spends several on
  // auth, settings, the page load, the slug check, the media lookup, and the
  // readback — so a statement per image would break saving an image-heavy page
  // on exactly the plan this project targets.
  for (let i = 0; i < mediaIds.length; i += MAX_BOUND_PARAMS - 1) {
    const chunk = mediaIds.slice(i, i + MAX_BOUND_PARAMS - 1); // -1 for pageId
    const placeholders = chunk.map(() => '?').join(', ');
    statements.push(
      // INSERT ... SELECT FROM media so a concurrently deleted row is skipped
      // rather than written as a dangling association.
      db
        .prepare(
          `INSERT OR IGNORE INTO page_media (page_id, media_id)
           SELECT ?1, m.id FROM media m WHERE m.id IN (${placeholders})`,
        )
        .bind(pageId, ...chunk),
    );
  }

  return statements;
}

/** Replace a page's media associations with exactly `mediaIds`. */
export async function syncPageMedia(
  db: D1Database,
  pageId: number,
  mediaIds: number[],
): Promise<void> {
  await db.batch(pageMediaClaimStatements(db, pageId, mediaIds));
}

/**
 * Point a product's gallery row at a different media item, guarded on that
 * media still existing. Returns false when the media vanished (or the gallery
 * row is gone), so the caller can refuse rather than write a dangling key.
 */
export async function replaceProductImageFromMedia(
  db: D1Database,
  productId: number,
  oldKey: string,
  mediaId: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE product_images
          SET image_key = (SELECT image_key FROM media WHERE id = ?3)
        WHERE product_id = ?1
          AND image_key = ?2
          AND EXISTS (SELECT 1 FROM media WHERE id = ?3)`,
    )
    .bind(productId, oldKey, mediaId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Store the header logo, sourced from `media` in the same statement that writes
 * it. A check-then-write leaves a window where the file is deleted between the
 * two, persisting a key that renders a broken logo site-wide. Returns false if
 * the media row is gone.
 */
export async function setLogoFromMedia(db: D1Database, imageKey: string): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO settings (key, value)
       SELECT 'logo_image_key', m.image_key FROM media m WHERE m.image_key = ?1
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .bind(imageKey)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}
