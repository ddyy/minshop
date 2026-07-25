import type { D1Database } from '@cloudflare/workers-types';
import { findMediaByKeys, pageMediaClaimStatements } from '../media/db.ts';
import { extractMediaKeys } from './markdown.ts';
import { type Page } from './db.ts';

export interface SaveResult {
  /** Keys the body references that are not in the media library. */
  unresolved: string[];
  /** True when a requested publish was refused because media was missing. */
  publishRefused: boolean;
  /** The publication state actually stored. */
  published: number;
}

/**
 * Persist a page body and rebuild its media associations, atomically.
 *
 * Unresolved media never costs the author their work: the text is always saved.
 * What it blocks is a DRAFT going live with images that would render broken.
 * An already-published page is left published — silently unpublishing a live
 * page because one image went missing is a far worse outcome than one broken
 * image the admin is warned about.
 *
 * The claims and the publish decision go in ONE batch, which D1 runs as a
 * transaction. Writing them separately left a race: media deleted after the
 * lookup but before the claims landed would be skipped silently, and the page
 * had already been published by then. Here the UPDATE decides `published` from
 * a COUNT of the rows the same transaction just claimed, so a claim that lost
 * to a concurrent delete refuses the draft-to-live transition instead.
 */
export async function savePageBody(
  db: D1Database,
  existing: Page,
  fields: {
    title: string;
    slug: string;
    body_markdown: string;
    published: number;
    layout: string;
  },
  options: { baseUrl?: string } = {},
): Promise<SaveResult> {
  const referenced = extractMediaKeys(fields.body_markdown, { baseUrl: options.baseUrl });
  const resolved = await findMediaByKeys(db, referenced);
  const resolvedKeys = new Set(resolved.map((m) => m.image_key));
  const unresolved = referenced.filter((key) => !resolvedKeys.has(key));

  // Publishing is refused when media is missing, but an explicit unpublish is
  // always honoured and a live page is never demoted.
  const wantsPublish = fields.published === 1;
  const blockedValue = wantsPublish ? existing.published : 0;
  const okValue = unresolved.length === 0 ? fields.published : blockedValue;

  await db.batch([
    ...pageMediaClaimStatements(
      db,
      existing.id,
      resolved.map((m) => m.id),
    ),
    db
      .prepare(
        `UPDATE pages
            SET title = ?2,
                slug = ?3,
                body_markdown = ?4,
                layout = ?5,
                published = CASE
                  WHEN (SELECT COUNT(*) FROM page_media WHERE page_id = ?1) = ?6
                  THEN ?7 ELSE ?8 END,
                updated_at = datetime('now')
          WHERE id = ?1`,
      )
      .bind(
        existing.id,
        fields.title,
        fields.slug,
        fields.body_markdown,
        fields.layout,
        resolved.length,
        okValue,
        blockedValue,
      ),
  ]);

  // Read back what the transaction actually stored rather than assuming.
  const saved = await db
    .prepare('SELECT published FROM pages WHERE id = ?')
    .bind(existing.id)
    .first<{ published: number }>();
  const published = saved?.published ?? blockedValue;

  return {
    unresolved,
    publishRefused: wantsPublish && published !== 1,
    published,
  };
}

/** Admin-facing summary of what happened, or '' when everything resolved. */
export function saveWarning(result: SaveResult): string {
  if (result.unresolved.length === 0 && !result.publishRefused) return '';
  const count = Math.max(result.unresolved.length, 1);
  const images = `${count} image${count === 1 ? '' : 's'}`;
  const is = count === 1 ? 'is' : 'are';
  if (result.publishRefused) {
    return `Changes saved, but this page was not published because ${images} ${is} missing from the media library.`;
  }
  if (result.published === 1) {
    return `Changes saved and live, but ${images} ${is} missing from the media library and will render broken.`;
  }
  return `Draft saved, but ${images} ${is} missing from the media library.`;
}
