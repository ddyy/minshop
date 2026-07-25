import type { D1Database } from '@cloudflare/workers-types';

/**
 * What `/` renders. The catalog list is the default and the fallback — a store
 * that has not chosen anything, or has chosen something that later disappeared,
 * still shows its products rather than an error.
 */
export type HomeTarget =
  | { kind: 'products' }
  | { kind: 'page'; id: number }
  | { kind: 'product'; id: number };

export const DEFAULT_HOME: HomeTarget = { kind: 'products' };

/**
 * Parse the stored setting. IDs, not slugs: renaming a page rewrites its slug,
 * and a setting pointing at the old one would silently stop resolving.
 */
export function parseHomeTarget(value: string | null | undefined): HomeTarget {
  if (!value) return DEFAULT_HOME;
  const [kind, rawId] = value.split(':');
  const id = Number(rawId);
  if ((kind === 'page' || kind === 'product') && Number.isInteger(id) && id > 0) {
    return { kind, id };
  }
  return DEFAULT_HOME;
}

/** Serialize for storage. The default is stored as '' so setSetting deletes it. */
export function serializeHomeTarget(target: HomeTarget): string {
  return target.kind === 'products' ? '' : `${target.kind}:${target.id}`;
}

/**
 * The path `/` should render, or null to render the catalog list.
 *
 * Resolution is deliberate about visibility: an unpublished page or an inactive
 * product resolves to null. Falling back to the catalog is the only acceptable
 * failure here — a 404 homepage would be served, and edge-cached, for everyone.
 */
export async function resolveHomePath(
  db: D1Database,
  value: string | null | undefined,
): Promise<string | null> {
  const target = parseHomeTarget(value);
  if (target.kind === 'products') return null;

  if (target.kind === 'page') {
    const row = await db
      .prepare('SELECT slug FROM pages WHERE id = ? AND published = 1')
      .bind(target.id)
      .first<{ slug: string }>();
    return row ? `/pages/${row.slug}` : null;
  }

  const row = await db
    .prepare('SELECT slug FROM products WHERE id = ? AND active = 1')
    .bind(target.id)
    .first<{ slug: string }>();
  return row ? `/products/${row.slug}` : null;
}

/**
 * Validate a submitted choice against the same visibility rules, so the setting
 * cannot be saved pointing at a draft or an inactive product.
 */
export async function homeTargetIsValid(
  db: D1Database,
  value: string,
): Promise<boolean> {
  if (!value) return true; // the default
  return (await resolveHomePath(db, value)) !== null;
}
