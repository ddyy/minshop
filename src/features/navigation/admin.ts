import type { D1Database } from '@cloudflare/workers-types';
import type { MenuItem, MenuLocation, MenuTargetType } from './db.ts';

/**
 * How many options a picker offers before the merchant has to search.
 *
 * Sized so most stores never hit it: below this the whole list is in the page
 * and filtering is instant and complete client-side. Past it, filtering has to
 * go back to the server, because a client-side filter over a truncated list
 * would confidently report 'no matches' for a product that exists just beyond
 * the cap.
 */
export const PICKER_LIMIT = 50;

export interface TargetOption {
  id: number;
  /** Prefixed public ID — what the admin picker submits; null only pre-backfill. */
  public_id: string | null;
  name: string;
}

export interface TargetChoices {
  options: TargetOption[];
  /** Matches beyond PICKER_LIMIT, so the UI can say "refine your search". */
  remaining: number;
}

/**
 * Options for the target picker.
 *
 * Bounded, and searchable rather than merely truncated. A single unbounded
 * <select> would render every product into every admin page load; a bare cap —
 * the mistake the home-page selector made — bounds the payload but makes item
 * N+1 permanently unselectable, which removes capability rather than limiting it.
 *
 * Alphabetical, not most-recent: `pages` has updated_at but `products` and
 * `categories` only have created_at, so a recency order would silently mean three
 * different things. It is also the wrong affordance — a merchant building
 * navigation is hunting for one known item, not reviewing recent edits.
 *
 * Only AVAILABLE targets are offered. An item already pointing at a draft or
 * inactive target still appears in the menu list with its warning; the list and
 * the picker answer different questions ("what is in this menu" vs "what may I
 * add"), so they deliberately disagree.
 */
export async function targetChoices(
  db: D1Database,
  targetType: MenuTargetType,
  query: string,
): Promise<TargetChoices> {
  const sources: Partial<Record<MenuTargetType, { table: string; name: string; where: string }>> = {
    page: { table: 'pages', name: 'title', where: 'published = 1' },
    product: { table: 'products', name: 'name', where: 'active = 1' },
    category: { table: 'categories', name: 'name', where: '1 = 1' },
  };
  const source = sources[targetType];
  if (!source) return { options: [], remaining: 0 };

  const q = query.trim();
  // LIKE with a short, merchant-supplied pattern only. D1 rejects long patterns
  // outright ("LIKE or GLOB pattern too complex"), so the search term is bounded.
  const filter = q ? `AND ${source.name} LIKE ?1` : '';
  const pattern = `%${q.slice(0, 60)}%`;

  const listSql = `SELECT id, public_id, ${source.name} AS name FROM ${source.table}
                    WHERE ${source.where} ${filter}
                    ORDER BY ${source.name} COLLATE NOCASE, id
                    LIMIT ${PICKER_LIMIT}`;
  const countSql = `SELECT COUNT(*) AS c FROM ${source.table}
                     WHERE ${source.where} ${filter}`;

  const [list, count] = await db.batch<Record<string, unknown>>([
    q ? db.prepare(listSql).bind(pattern) : db.prepare(listSql),
    q ? db.prepare(countSql).bind(pattern) : db.prepare(countSql),
  ]);

  const options = (list.results ?? []) as unknown as TargetOption[];
  const total = Number((count.results?.[0] as { c?: number } | undefined)?.c ?? 0);
  return { options, remaining: Math.max(0, total - options.length) };
}

/**
 * Why an item is hidden on the storefront, or null when it is fine.
 *
 * Categories have no draft or inactive state — 0004_categories.sql defines only
 * id/name/slug/parent_id/created_at — so deletion is the only way one becomes
 * unavailable, which also makes it the easiest to miss.
 */
export function unavailableReason(item: MenuItem): string | null {
  if (item.available) return null;
  // targetExists, not an empty label: a custom label outlives its target, so a
  // deleted page labelled "Company" still renders text and would otherwise be
  // reported as a draft — sending the merchant to un-draft a page that is gone.
  if (!item.targetExists) return 'Target no longer exists';
  switch (item.targetType) {
    case 'page':
      return 'Draft — hidden on the storefront';
    case 'product':
      return 'Inactive — hidden on the storefront';
    case 'category':
      return 'Target no longer exists';
    default:
      return 'Unavailable';
  }
}

/**
 * Which menus reference each of these targets, keyed by target id.
 *
 * For the admin list pages, so deleting a page/product/category can say what it
 * will break BEFORE it happens. The storefront hides the resulting dead item
 * safely, but silently — without this the merchant only discovers the gap later,
 * in Navigation, with no idea why a menu shrank.
 *
 * One bounded query for the whole list rather than one per row. Ids come from a
 * page of admin rows, so the IN list is small, but chunk anyway: D1 allows 100
 * bound parameters per query.
 */
export async function menuReferencesFor(
  db: D1Database,
  targetType: MenuTargetType,
  ids: number[],
): Promise<Map<number, MenuLocation[]>> {
  const found = new Map<number, MenuLocation[]>();
  if (ids.length === 0) return found;

  const CHUNK = 90; // under D1's 100-parameter ceiling, with room for target_type
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await db
      .prepare(
        `SELECT DISTINCT target_id, location FROM menu_items
          WHERE target_type = ? AND target_id IN (${placeholders})`,
      )
      .bind(targetType, ...chunk)
      .all<{ target_id: number; location: MenuLocation }>();
    for (const row of results ?? []) {
      const list = found.get(row.target_id) ?? [];
      if (!list.includes(row.location)) list.push(row.location);
      found.set(row.target_id, list);
    }
  }
  return found;
}

export const TARGET_TYPE_LABELS: Record<MenuTargetType, string> = {
  home: 'Home',
  catalog: 'Catalog',
  page: 'Page',
  product: 'Product',
  category: 'Category',
};
