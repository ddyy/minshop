import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { catalogPath, resolveHomePath } from '../settings/home.ts';
import { withPublicId } from '../ids/publicId.ts';

export type MenuLocation = 'header' | 'footer';
export type MenuTargetType = 'home' | 'catalog' | 'page' | 'product' | 'category';

export const MENU_LOCATIONS: readonly MenuLocation[] = ['header', 'footer'];
export const MENU_TARGET_TYPES: readonly MenuTargetType[] = [
  'home',
  'catalog',
  'page',
  'product',
  'category',
];

/**
 * Per-location caps. The header number is a LAYOUT constraint, not a preference:
 * the header already carries the logo, the search field, and up to five store
 * links (Shop, Blog, Search, Cart, Account) before a merchant adds anything, so
 * six is what a single row can actually hold at 1280px. The footer number is the
 * contract that already exists — MAX_FOOTER_PAGE_LINKS — written down, so the
 * migration's seed can be lossless.
 *
 * One source of truth: the migration seed, the add guard, and the read ceiling
 * all derive from this, so they cannot drift apart.
 */
export const MENU_CAPS: Record<MenuLocation, number> = { header: 6, footer: 50 };

/**
 * What Home and Catalog are called when no override is set.
 *
 * Exported so the resolution query and the admin form read the same values —
 * admin tells the merchant what a blank label will fall back to, and that
 * promise has to match what the storefront actually renders.
 */
export const SINGLETON_LABELS: Record<'home' | 'catalog', string> = {
  home: 'Home',
  catalog: 'Shop',
};

/** Label overrides are merchant free text; bound it before it reaches the DOM. */
export const MAX_MENU_LABEL = 60;

export interface MenuItemRow {
  id: number;
  public_id: string | null;
  location: MenuLocation;
  target_type: MenuTargetType;
  target_id: number | null;
  position: number;
  label: string | null;
  target_name: string | null;
  target_slug: string | null;
  available: number;
}

export interface MenuItem {
  id: number;
  /** Prefixed nav_ public ID — what admin forms submit; null only pre-backfill. */
  publicId: string | null;
  location: MenuLocation;
  targetType: MenuTargetType;
  targetId: number | null;
  position: number;
  /** Merchant override, or null when the target's own name is used. */
  label: string | null;
  /** What actually renders. */
  text: string;
  /**
   * The target's own name — page title, product name, category name, or the
   * literal for a singleton. Admin needs it alongside `text` to show what a
   * custom label is overriding; without it a renamed item gives no clue which
   * object it points at.
   */
  targetName: string | null;
  href: string;
  available: boolean;
  /**
   * Whether the joined row was found at all.
   *
   * Distinct from `available`, and not derivable from `text`: a custom label
   * survives its target's deletion, so a deleted page labelled "Company" still
   * renders text. Only the join can tell "deleted" from "draft" — target_name is
   * NULL when nothing matched, and the join deliberately carries no published /
   * active filter so a draft page still produces a name.
   */
  targetExists: boolean;
}

export interface Menus {
  header: MenuItem[];
  footer: MenuItem[];
}

export const EMPTY_MENUS: Menus = { header: [], footer: [] };

/**
 * Both menus, fully resolved, in one statement.
 *
 * Bounded before the joins, not after. A `ROW_NUMBER() OVER (PARTITION BY ...)`
 * filtered on the outside also caps the OUTPUT, but every row in menu_items is
 * still read and ranked first — on every storefront request. Two LIMITed
 * subqueries let the planner walk idx_menu_items_location and stop at each
 * location's cap, so the WORK is bounded too. Nothing in the schema limits rows
 * per location, so this cannot rely on the add guard: a bad migration or a direct
 * D1 write would otherwise land straight in the hot path.
 *
 * Singleton labels are supplied here. Without them an unlabelled Home or Catalog
 * item resolves COALESCE(NULL, NULL) and renders an empty, invisible link.
 */
export const MENU_ITEMS_SQL = `
WITH bounded AS (
  SELECT * FROM (
    SELECT * FROM menu_items WHERE location = 'header'
     ORDER BY position, id LIMIT ${MENU_CAPS.header}
  )
  UNION ALL
  SELECT * FROM (
    SELECT * FROM menu_items WHERE location = 'footer'
     ORDER BY position, id LIMIT ${MENU_CAPS.footer}
  )
)
SELECT
  mi.id, mi.public_id, mi.location, mi.target_type, mi.target_id, mi.position, mi.label,
  CASE mi.target_type
    WHEN 'home'     THEN '${SINGLETON_LABELS.home}'
    WHEN 'catalog'  THEN '${SINGLETON_LABELS.catalog}'
    WHEN 'page'     THEN pg.title
    WHEN 'product'  THEN pr.name
    WHEN 'category' THEN c.name
  END AS target_name,
  CASE mi.target_type
    WHEN 'page'     THEN pg.slug
    WHEN 'product'  THEN pr.slug
    WHEN 'category' THEN c.slug
  END AS target_slug,
  CASE mi.target_type
    WHEN 'home'     THEN 1
    WHEN 'catalog'  THEN 1
    WHEN 'page'     THEN CASE WHEN pg.published = 1 THEN 1 ELSE 0 END
    WHEN 'product'  THEN CASE WHEN pr.active = 1 THEN 1 ELSE 0 END
    WHEN 'category' THEN CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END
  END AS available
FROM bounded mi
LEFT JOIN pages      pg ON mi.target_type = 'page'     AND pg.id = mi.target_id
LEFT JOIN products   pr ON mi.target_type = 'product'  AND pr.id = mi.target_id
LEFT JOIN categories c  ON mi.target_type = 'category' AND c.id  = mi.target_id
ORDER BY mi.location, mi.position, mi.id`;

/**
 * Where an item points. Resolved in code, not SQL, because 'catalog' depends on
 * a store setting: the catalog lives at `/` normally and at `/products` once the
 * home page has been pointed elsewhere.
 */
export function resolveMenuHref(
  targetType: MenuTargetType,
  slug: string | null,
  homePage: string | null | undefined,
): string {
  switch (targetType) {
    case 'home':
      return '/';
    case 'catalog':
      return catalogPath(homePage);
    case 'page':
      return `/pages/${slug}`;
    case 'product':
      return `/products/${slug}`;
    case 'category':
      return `/categories/${slug}`;
  }
}

/** Row → renderable item. `text` is the override, else the target's own name. */
export function toMenuItem(row: MenuItemRow, homePage: string | null | undefined): MenuItem {
  return {
    id: row.id,
    publicId: row.public_id,
    location: row.location,
    targetType: row.target_type,
    targetId: row.target_id,
    position: row.position,
    label: row.label,
    text: row.label ?? row.target_name ?? '',
    targetName: row.target_name,
    href: resolveMenuHref(row.target_type, row.target_slug, homePage),
    available: row.available === 1,
    // Singletons are always "found": the query supplies their name literally.
    targetExists: row.target_name !== null,
  };
}

/** Split a flat result set into the two menus, preserving order. */
export function groupMenus(rows: MenuItemRow[], homePage: string | null | undefined): Menus {
  const menus: Menus = { header: [], footer: [] };
  for (const row of rows) {
    const item = toMenuItem(row, homePage);
    // Defensive: a location outside the CHECK constraint would otherwise throw.
    if (item.location === 'header' || item.location === 'footer') menus[item.location].push(item);
  }
  return menus;
}

/** Storefront view: unavailable targets are dropped, never rendered as dead links. */
export function visibleItems(items: MenuItem[]): MenuItem[] {
  return items.filter((i) => i.available && i.text !== '');
}

export async function getMenus(
  db: D1Database,
  homePage: string | null | undefined,
): Promise<Menus> {
  const { results } = await db.prepare(MENU_ITEMS_SQL).all<MenuItemRow>();
  return groupMenus(results ?? [], homePage);
}

export const isMenuLocation = (v: unknown): v is MenuLocation =>
  typeof v === 'string' && (MENU_LOCATIONS as readonly string[]).includes(v);

export const isMenuTargetType = (v: unknown): v is MenuTargetType =>
  typeof v === 'string' && (MENU_TARGET_TYPES as readonly string[]).includes(v);

export const isSingleton = (t: MenuTargetType): boolean => t === 'home' || t === 'catalog';

/** Empty/blank overrides are stored as NULL so COALESCE does the fallback. */
export function normalizeLabel(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text === '' ? null : text.slice(0, MAX_MENU_LABEL);
}

export type AddFailure = 'full' | 'duplicate' | 'unavailable';
export type AddResult = { ok: true; id: number } | { ok: false; reason: AddFailure };

/**
 * Add one item.
 *
 * Guarded single statement rather than check-then-insert: the count, the target
 * check, and the singleton check all have to hold at the moment of the write, and
 * the next position is computed in the same statement so two admin tabs cannot
 * collide on it.
 *
 * The target check is here, not only in the picker. The UI offering only
 * available targets is a convenience; a stale form, a resubmitted POST, or a
 * hand-crafted request must not be able to add a draft page or an inactive
 * product.
 *
 * The singleton check is here too, even though a partial unique index also
 * enforces it, because the index enforces it by RAISING — which reaches the
 * merchant as a 500 rather than as a sentence. The index stays as the backstop
 * for a genuine race where two requests both pass this guard.
 */
export async function addMenuItem(
  db: D1Database,
  input: {
    location: MenuLocation;
    targetType: MenuTargetType;
    targetId: number | null;
    label: string | null;
  },
): Promise<AddResult> {
  const { location, targetType, targetId, label } = input;
  const cap = MENU_CAPS[location];

  try {
    const result = await withPublicId('navItem', (publicId) =>
      db
        .prepare(
          `INSERT INTO menu_items (location, target_type, target_id, label, position, public_id)
           SELECT ?1, ?2, ?3, ?4,
                  (SELECT COALESCE(MAX(position), -1) + 1 FROM menu_items WHERE location = ?1),
                  ?6
            WHERE (SELECT COUNT(*) FROM menu_items WHERE location = ?1) < ?5
              AND (
                    (?2 IN ('home', 'catalog') AND ?3 IS NULL)
                 OR (?2 = 'page'     AND EXISTS (SELECT 1 FROM pages      WHERE id = ?3 AND published = 1))
                 OR (?2 = 'product'  AND EXISTS (SELECT 1 FROM products   WHERE id = ?3 AND active = 1))
                 OR (?2 = 'category' AND EXISTS (SELECT 1 FROM categories WHERE id = ?3))
              )
              AND NOT (
                    ?2 IN ('home', 'catalog')
                AND EXISTS (SELECT 1 FROM menu_items WHERE location = ?1 AND target_type = ?2)
              )`,
        )
        .bind(location, targetType, targetId, label, cap, publicId)
        .run(),
    );

    if (result.meta.changes > 0) return { ok: true, id: result.meta.last_row_id };
  } catch (err) {
    // The backstop fired: another request inserted the same singleton between our
    // guard and our write. Same outcome as the guarded case, same message.
    if (/UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err))) {
      return { ok: false, reason: 'duplicate' };
    }
    throw err;
  }

  // Zero changes has three causes and the merchant needs to know which. Only the
  // failure path pays for these reads; the success path stayed one statement.
  return { ok: false, reason: await diagnoseAddFailure(db, location, targetType, cap) };
}

async function diagnoseAddFailure(
  db: D1Database,
  location: MenuLocation,
  targetType: MenuTargetType,
  cap: number,
): Promise<AddFailure> {
  if (isSingleton(targetType)) {
    const dupe = await db
      .prepare('SELECT 1 AS x FROM menu_items WHERE location = ? AND target_type = ? LIMIT 1')
      .bind(location, targetType)
      .first<{ x: number }>();
    if (dupe) return 'duplicate';
  }
  const count = await db
    .prepare('SELECT COUNT(*) AS c FROM menu_items WHERE location = ?')
    .bind(location)
    .first<{ c: number }>();
  return (count?.c ?? 0) >= cap ? 'full' : 'unavailable';
}

/** Menu-item row id for a nav_ public ID (boundary resolution; null if missing). */
export async function getMenuItemIdByPublicId(
  db: D1Database,
  publicId: string,
): Promise<number | null> {
  const row = await db
    .prepare('SELECT id FROM menu_items WHERE public_id = ?')
    .bind(publicId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/** public_id → row id for one menu, for resolving a submitted reorder list. */
export async function menuItemIdsByPublicId(
  db: D1Database,
  location: MenuLocation,
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare('SELECT id, public_id FROM menu_items WHERE location = ?')
    .bind(location)
    .all<{ id: number; public_id: string | null }>();
  const map = new Map<string, number>();
  for (const row of results ?? []) {
    if (row.public_id) map.set(row.public_id, row.id);
  }
  return map;
}

export async function removeMenuItem(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM menu_items WHERE id = ?').bind(id).run();
}

export async function setMenuItemLabel(
  db: D1Database,
  id: number,
  label: string | null,
): Promise<void> {
  await db.prepare('UPDATE menu_items SET label = ? WHERE id = ?').bind(label, id).run();
}

/**
 * Swap an item with its neighbour.
 *
 * Both writes go in one batch so a failure cannot leave two items sharing a
 * position — which would still render, but in an order the merchant did not
 * choose and cannot predict.
 */
export async function moveMenuItem(
  db: D1Database,
  id: number,
  direction: 'up' | 'down',
): Promise<void> {
  const item = await db
    .prepare('SELECT id, location, position FROM menu_items WHERE id = ?')
    .bind(id)
    .first<{ id: number; location: MenuLocation; position: number }>();
  if (!item) return;

  // position, id — matching the read order, so the neighbour found here is the
  // one actually rendered next to it even when positions collide.
  const neighbour = await db
    .prepare(
      direction === 'up'
        ? `SELECT id, position FROM menu_items
            WHERE location = ?1 AND (position < ?2 OR (position = ?2 AND id < ?3))
            ORDER BY position DESC, id DESC LIMIT 1`
        : `SELECT id, position FROM menu_items
            WHERE location = ?1 AND (position > ?2 OR (position = ?2 AND id > ?3))
            ORDER BY position ASC, id ASC LIMIT 1`,
    )
    .bind(item.location, item.position, item.id)
    .first<{ id: number; position: number }>();
  if (!neighbour) return;

  await db.batch([
    db.prepare('UPDATE menu_items SET position = ? WHERE id = ?').bind(neighbour.position, item.id),
    db.prepare('UPDATE menu_items SET position = ? WHERE id = ?').bind(item.position, neighbour.id),
  ]);
}

/**
 * Set the whole order of one menu from an ordered id list (drag-and-drop).
 *
 * One CASE statement per chunk rather than one UPDATE per row: 50 footer items
 * would otherwise be 50 statements, and D1 allows only 50 queries per Worker
 * invocation on the Free plan — the admin request already spends some of that.
 * Chunked at 30 because each item costs two bound parameters (one in the CASE,
 * one in the IN list) against D1's 100-parameter ceiling: 30 + 1 + 30 = 61.
 *
 * Positions are interpolated integers, not parameters — they are array indices
 * this function computes, never merchant input.
 *
 * Scoped by location, so a tampered id list cannot drag an item out of the menu
 * it belongs to.
 */
export async function reorderMenuItems(
  db: D1Database,
  location: MenuLocation,
  ids: number[],
): Promise<boolean> {
  // The list must be a complete, duplicate-free permutation of this menu.
  //
  // Updating only the supplied rows is not enough on its own: a partial list
  // assigns position 0 to one row while an omitted row keeps position 0, and the
  // rendered order then falls to the `position, id` tie-breaker — an order the
  // merchant never chose. Duplicates collapse two rows onto one position for the
  // same reason. Validated here rather than in the route, so the browser is not
  // the correctness boundary.
  const { results } = await db
    .prepare('SELECT id FROM menu_items WHERE location = ?')
    .bind(location)
    .all<{ id: number }>();
  const current = new Set((results ?? []).map((r) => r.id));
  const submitted = new Set(ids);
  if (submitted.size !== ids.length) return false; // duplicates
  if (submitted.size !== current.size) return false; // incomplete or padded
  for (const id of current) if (!submitted.has(id)) return false; // different rows

  if (ids.length === 0) return true;
  const CHUNK = 30;
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const cases = chunk.map((_, j) => `WHEN ? THEN ${i + j}`).join(' ');
    const placeholders = chunk.map(() => '?').join(', ');
    statements.push(
      db
        .prepare(
          `UPDATE menu_items SET position = CASE id ${cases} ELSE position END
            WHERE location = ? AND id IN (${placeholders})`,
        )
        .bind(...chunk, location, ...chunk),
    );
  }
  await db.batch(statements);
  return true;
}

/**
 * True when the storefront has no path to the catalog.
 *
 * The migration seeds a Shop item only for stores whose home page was ALREADY
 * overridden. A store that overrides it later loses the old automatic Shop link
 * (this feature removed it), leaves the logo pointing at the custom home page,
 * and ends up with /products unreachable from anywhere in the navigation. Admin
 * warns at the point of that decision rather than silently editing a menu the
 * merchant curates.
 */
export async function catalogIsOrphaned(
  db: D1Database,
  homePage: string | null | undefined,
): Promise<boolean> {
  if (!homePage) return false; // '/' is the catalog; nothing to link to.
  // Resolve rather than trust the stored value. A setting pointing at a page
  // that was later unpublished, or a product since deactivated, no longer takes
  // over '/' — the storefront has already fallen back to the catalog. Treating
  // any non-empty setting as a live override would make admin claim the home
  // page IS the product list and, in the same breath, that shoppers cannot reach
  // the product list.
  if (!(await resolveHomePath(db, homePage))) return false;
  const found = await db
    .prepare("SELECT 1 AS x FROM menu_items WHERE target_type = 'catalog' LIMIT 1")
    .first<{ x: number }>();
  return !found;
}
