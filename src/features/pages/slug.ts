import type { D1Database } from '@cloudflare/workers-types';
import { slugify } from '../products/slug';

/**
 * Page slugs live under /pages/, their own namespace, so they cannot collide
 * with /products/, /categories/, or any future top-level route. That is why
 * there is no reserved-slug list to maintain here.
 */

/** Slugify, but fall back to `page` rather than the product helper's `product`. */
export function pageSlugify(input: string): string {
  const slug = slugify(input);
  return slug === 'product' && !/product/i.test(input) ? 'page' : slug;
}

/**
 * Return a slug unique across pages, appending -2, -3, … on collision.
 * Pass excludeId when updating so a page doesn't collide with itself.
 */
export async function uniquePageSlug(
  db: D1Database,
  base: string,
  excludeId?: number,
): Promise<string> {
  const slug = pageSlugify(base);
  let candidate = slug;
  let n = 1;
  while (true) {
    const row = await db
      .prepare(`SELECT id FROM pages WHERE slug = ?${excludeId ? ' AND id != ?' : ''} LIMIT 1`)
      .bind(...(excludeId ? [candidate, excludeId] : [candidate]))
      .first<{ id: number }>();
    if (!row) return candidate;
    n += 1;
    candidate = `${slug}-${n}`;
  }
}
