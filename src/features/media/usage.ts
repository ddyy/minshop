import type { D1Database } from '@cloudflare/workers-types';

/** Everywhere one media item is currently used. Empty everywhere = deletable. */
export interface MediaUsage {
  products: Array<{ id: number; name: string }>;
  pages: Array<{ id: number; title: string }>;
  logo: boolean;
}

export function emptyUsage(): MediaUsage {
  return { products: [], pages: [], logo: false };
}

export function isUnused(usage: MediaUsage): boolean {
  return usage.products.length === 0 && usage.pages.length === 0 && !usage.logo;
}

/**
 * Product usage reads BOTH sources the delete guard checks: the gallery and the
 * denormalized `products.image_key`. Reading only `product_images` would report
 * a primary-only image as unused, so the grid would offer a Delete button that
 * the guarded statement then refuses with 409.
 *
 * UNION (not UNION ALL) plus DISTINCT collapses duplicate gallery rows, which
 * existing databases are explicitly allowed to contain, so one product appears
 * once per media item rather than once per row.
 */
const PRODUCT_USAGE_SQL = `
  SELECT DISTINCT m.id AS media_id, p.id AS product_id, p.name AS product_name
    FROM media m
    JOIN (
      SELECT product_id, image_key FROM product_images
      UNION
      SELECT id AS product_id, image_key FROM products WHERE image_key IS NOT NULL
    ) refs ON refs.image_key = m.image_key
    JOIN products p ON p.id = refs.product_id
   WHERE m.id IN (%IDS%)
   ORDER BY p.name`;

const PAGE_USAGE_SQL = `
  SELECT pm.media_id AS media_id, pg.id AS page_id, pg.title AS page_title
    FROM page_media pm
    JOIN pages pg ON pg.id = pm.page_id
   WHERE pm.media_id IN (%IDS%)
   ORDER BY pg.title`;

/**
 * Usage for a whole grid page in a bounded number of statements — never one
 * query per row. Ids are bound once per statement (48 parameters for a full
 * page) by joining through `media` rather than also binding a derived key list.
 */
export async function mediaUsageForIds(
  db: D1Database,
  ids: number[],
): Promise<Map<number, MediaUsage>> {
  const usage = new Map<number, MediaUsage>();
  for (const id of ids) usage.set(id, emptyUsage());
  if (ids.length === 0) return usage;

  const placeholders = ids.map(() => '?').join(', ');
  const [products, pages, logo] = await db.batch<Record<string, unknown>>([
    db.prepare(PRODUCT_USAGE_SQL.replace('%IDS%', placeholders)).bind(...ids),
    db.prepare(PAGE_USAGE_SQL.replace('%IDS%', placeholders)).bind(...ids),
    db.prepare("SELECT value FROM settings WHERE key = 'logo_image_key'"),
  ]);

  for (const row of (products.results ?? []) as Array<{
    media_id: number;
    product_id: number;
    product_name: string;
  }>) {
    usage.get(row.media_id)?.products.push({ id: row.product_id, name: row.product_name });
  }
  for (const row of (pages.results ?? []) as Array<{
    media_id: number;
    page_id: number;
    page_title: string;
  }>) {
    usage.get(row.media_id)?.pages.push({ id: row.page_id, title: row.page_title });
  }

  const logoKey = ((logo.results ?? []) as Array<{ value: string }>)[0]?.value;
  if (logoKey) {
    // One extra lookup for the single logo key, not one per row.
    const row = await db
      .prepare('SELECT id FROM media WHERE image_key = ?')
      .bind(logoKey)
      .first<{ id: number }>();
    const entry = row ? usage.get(row.id) : undefined;
    if (entry) entry.logo = true;
  }

  return usage;
}

/** Detailed usage for one media item — deletion errors and single inspection. */
export async function mediaUsage(db: D1Database, id: number): Promise<MediaUsage> {
  const map = await mediaUsageForIds(db, [id]);
  return map.get(id) ?? emptyUsage();
}

/** Human-readable "why can't I delete this" message. */
export function describeUsage(usage: MediaUsage): string {
  const parts: string[] = [];
  if (usage.products.length > 0) {
    parts.push(
      `${usage.products.length} product${usage.products.length === 1 ? '' : 's'} (${usage.products
        .map((p) => p.name)
        .join(', ')})`,
    );
  }
  if (usage.pages.length > 0) {
    parts.push(
      `${usage.pages.length} page${usage.pages.length === 1 ? '' : 's'} (${usage.pages
        .map((p) => p.title)
        .join(', ')})`,
    );
  }
  if (usage.logo) parts.push('the store logo');
  return parts.join(' and ');
}
