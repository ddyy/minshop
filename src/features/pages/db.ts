import type { D1Database } from '@cloudflare/workers-types';

export interface Page {
  id: number;
  title: string;
  slug: string;
  body_markdown: string;
  published: number;
  created_at: string;
  updated_at: string;
}

export interface PageLink {
  title: string;
  slug: string;
}

/**
 * Footer cap. The footer is a flat list with no ordering model, so a store with
 * hundreds of pages would otherwise render hundreds of links AND pull them on
 * every storefront document. First 50 by title is a bound, not a feature.
 */
export const MAX_FOOTER_PAGE_LINKS = 50;

/** Deterministic footer order; matches the pages_published_title NOCASE index. */
export const PUBLISHED_PAGE_LINKS_SQL = `SELECT title, slug FROM pages
   WHERE published = 1
   ORDER BY title COLLATE NOCASE, id
   LIMIT ${MAX_FOOTER_PAGE_LINKS}`;

export async function getPage(db: D1Database, id: number): Promise<Page | null> {
  return db.prepare('SELECT * FROM pages WHERE id = ?').bind(id).first<Page>();
}

export async function getPublishedPageBySlug(
  db: D1Database,
  slug: string,
): Promise<Page | null> {
  return db
    .prepare('SELECT * FROM pages WHERE slug = ? AND published = 1')
    .bind(slug)
    .first<Page>();
}

/** Admin listing: drafts included, newest activity first. */
export async function listPages(db: D1Database): Promise<Page[]> {
  const { results } = await db
    .prepare('SELECT * FROM pages ORDER BY updated_at DESC, id DESC')
    .all<Page>();
  return results ?? [];
}

export async function listPublishedPageLinks(db: D1Database): Promise<PageLink[]> {
  const { results } = await db.prepare(PUBLISHED_PAGE_LINKS_SQL).all<PageLink>();
  return results ?? [];
}

/** Every published page, for the sitemap and llms.txt (no footer cap). */
export async function listPublishedPages(db: D1Database): Promise<PageLink[]> {
  const { results } = await db
    .prepare('SELECT title, slug FROM pages WHERE published = 1 ORDER BY title COLLATE NOCASE, id')
    .all<PageLink>();
  return results ?? [];
}

/** New pages start unpublished: media can only be attached once an id exists. */
export async function createDraft(
  db: D1Database,
  title: string,
  slug: string,
): Promise<number> {
  const row = await db
    .prepare('INSERT INTO pages (title, slug, published) VALUES (?, ?, 0) RETURNING id')
    .bind(title, slug)
    .first<{ id: number }>();
  if (!row) throw new Error('page insert returned no row');
  return row.id;
}

export async function updatePage(
  db: D1Database,
  id: number,
  fields: { title: string; slug: string; body_markdown: string; published: number },
): Promise<void> {
  // updated_at is application-maintained — the column default only covers
  // insert, so without this the admin's "Updated" would stay at creation time.
  await db
    .prepare(
      `UPDATE pages
          SET title = ?, slug = ?, body_markdown = ?, published = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    )
    .bind(fields.title, fields.slug, fields.body_markdown, fields.published, id)
    .run();
}

/**
 * Delete a page and its media associations. The media itself is untouched —
 * those files may be used elsewhere, and only the media library deletes objects.
 */
export async function deletePage(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM page_media WHERE page_id = ?').bind(id),
    db.prepare('DELETE FROM pages WHERE id = ?').bind(id),
  ]);
}
