import type { D1Database } from '@cloudflare/workers-types';
import { findMediaByKeys, syncPageMedia } from '../media/db.ts';
import { extractMediaKeys } from './markdown.ts';
import { updatePage, type Page } from './db.ts';

export interface SaveResult {
  /** Keys the body references that are not in the media library. */
  unresolved: string[];
  /** True when a requested publish was refused because of unresolved media. */
  publishRefused: boolean;
  /** The publication state actually stored. */
  published: number;
}

/**
 * Persist a page body and rebuild its media associations.
 *
 * Unresolved media never costs the author their work: the text is always saved.
 * What it blocks is a DRAFT going live with images that would render broken.
 * An already-published page is left published — silently unpublishing a live
 * page because one image went missing is a far worse outcome than one broken
 * image the admin is warned about.
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

  const wantsPublish = fields.published === 1;
  const publishRefused = wantsPublish && unresolved.length > 0 && existing.published === 0;
  // Refusing a publish leaves the EXISTING state, it does not force a draft.
  const published = publishRefused ? existing.published : fields.published;

  await updatePage(db, existing.id, { ...fields, published });
  // Associate only what resolved; syncPageMedia is itself guarded against a
  // media row disappearing between the lookup and the write.
  await syncPageMedia(db, existing.id, resolved.map((m) => m.id));

  return { unresolved, publishRefused, published };
}

/** Admin-facing summary of what happened, or '' when everything resolved. */
export function saveWarning(result: SaveResult): string {
  if (result.unresolved.length === 0) return '';
  const count = result.unresolved.length;
  const images = `${count} image${count === 1 ? '' : 's'}`;
  if (result.publishRefused) {
    return `Changes saved, but this page was not published because ${images} ${
      count === 1 ? 'is' : 'are'
    } missing from the media library.`;
  }
  if (result.published === 1) {
    return `Changes saved and live, but ${images} ${
      count === 1 ? 'is' : 'are'
    } missing from the media library and will render broken.`;
  }
  return `Draft saved, but ${images} ${count === 1 ? 'is' : 'are'} missing from the media library.`;
}
