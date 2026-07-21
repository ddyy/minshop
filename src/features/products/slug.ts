import type { D1Database } from '@cloudflare/workers-types';

const DIACRITICS = /[̀-ͯ]/g;

/** Turn arbitrary text into a URL-safe slug. */
export function slugify(input: string): string {
  const base = input
    .normalize('NFKD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/['’`]/g, '') // drop apostrophes so "mom's" → "moms", not "mom-s"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'product';
}

/**
 * Return a slug unique across products, appending -2, -3, … on collision.
 * Pass excludeId when updating so a product doesn't collide with itself.
 */
export async function uniqueSlug(
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
        `SELECT id FROM products WHERE slug = ?${excludeId ? ' AND id != ?' : ''} LIMIT 1`,
      )
      .bind(...(excludeId ? [candidate, excludeId] : [candidate]))
      .first<{ id: number }>();
    if (!row) return candidate;
    n += 1;
    candidate = `${slug}-${n}`;
  }
}
