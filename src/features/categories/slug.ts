import type { D1Database } from '@cloudflare/workers-types';
import { slugify } from '../products/slug';

/**
 * Return a slug unique across categories, appending -2, -3, … on collision.
 * Pass excludeId when updating so a category doesn't collide with itself.
 */
export async function uniqueCategorySlug(
  db: D1Database,
  base: string,
  excludeId?: number,
): Promise<string> {
  const slug = slugify(base);
  let candidate = slug;
  let n = 1;
  while (true) {
    const row = await db
      .prepare(
        `SELECT id FROM categories WHERE slug = ?${excludeId ? ' AND id != ?' : ''} LIMIT 1`,
      )
      .bind(...(excludeId ? [candidate, excludeId] : [candidate]))
      .first<{ id: number }>();
    if (!row) return candidate;
    n += 1;
    candidate = `${slug}-${n}`;
  }
}
