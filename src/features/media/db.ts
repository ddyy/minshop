import type { D1Database } from '@cloudflare/workers-types';

export interface Media {
  id: number;
  image_key: string;
  original_name: string;
  mime_type: string | null;
  size_bytes: number | null;
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

/** Resolve media rows for a set of keys (used when parsing Markdown bodies). */
export async function findMediaByKeys(db: D1Database, keys: string[]): Promise<Media[]> {
  if (keys.length === 0) return [];
  const placeholders = keys.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT * FROM media WHERE image_key IN (${placeholders})`)
    .bind(...keys)
    .all<Media>();
  return results ?? [];
}

export async function createMediaRecord(
  db: D1Database,
  fields: {
    image_key: string;
    original_name: string;
    mime_type: string | null;
    size_bytes: number | null;
  },
): Promise<Media> {
  const row = await db
    .prepare(
      `INSERT INTO media (image_key, original_name, mime_type, size_bytes)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(fields.image_key, fields.original_name, fields.mime_type, fields.size_bytes)
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

/** Replace a page's media associations with exactly `mediaIds`. */
export async function syncPageMedia(
  db: D1Database,
  pageId: number,
  mediaIds: number[],
): Promise<void> {
  const statements = [
    db.prepare('DELETE FROM page_media WHERE page_id = ?').bind(pageId),
    // INSERT ... SELECT FROM media so a concurrently deleted row is skipped
    // rather than written as a dangling association.
    ...mediaIds.map((mediaId) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO page_media (page_id, media_id)
           SELECT ?1, m.id FROM media m WHERE m.id = ?2`,
        )
        .bind(pageId, mediaId),
    ),
  ];
  await db.batch(statements);
}
