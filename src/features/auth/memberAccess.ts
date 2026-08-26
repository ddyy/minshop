import type { D1Database } from '@cloudflare/workers-types';
import type { StoreSettings } from '../settings/db';

export type MemberAccessMode = 'off' | 'store' | 'selective';

/** Product is gated when its own flag is set or it sits in a members-only category. */
export const PRODUCT_MEMBERS_ONLY_SQL = `(
  p.members_only = 1 OR EXISTS (
    SELECT 1 FROM product_categories pc
    JOIN categories c ON c.id = pc.category_id
    WHERE pc.product_id = p.id AND c.members_only = 1
  )
)`;

/** Anonymous storefront listings omit gated products in selective mode. */
export function publicProductVisibilitySql(alias = 'p'): string {
  const col = alias === 'p' ? 'p.members_only' : `${alias}.members_only`;
  const id = alias === 'p' ? 'p.id' : `${alias}.id`;
  return `(
    ${col} = 0 AND NOT EXISTS (
      SELECT 1 FROM product_categories pc
      JOIN categories c ON c.id = pc.category_id
      WHERE pc.product_id = ${id} AND c.members_only = 1
    )
  )`;
}

export function memberAccessMode(settings: StoreSettings | undefined | null): MemberAccessMode {
  return settings?.memberAccessMode ?? 'off';
}

export function memberAccessEnabled(settings: StoreSettings | undefined | null): boolean {
  return memberAccessMode(settings) !== 'off';
}

/** Selective mode, anonymous visitor — omit gated products from public listings. */
export function hideMembersOnlyProducts(
  settings: StoreSettings | undefined | null,
  memberAuthenticated: boolean | undefined,
): boolean {
  return memberAccessMode(settings) === 'selective' && !memberAuthenticated;
}

export function memberLoginRedirect(requestUrl: URL, nextPath?: string): string {
  const next = nextPath && nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : '';
  return next ? `/login?next=${encodeURIComponent(next)}` : '/login';
}

export async function productRequiresMemberAccess(
  db: D1Database,
  productId: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS gated FROM products p WHERE p.id = ? AND ${PRODUCT_MEMBERS_ONLY_SQL}`,
    )
    .bind(productId)
    .first<{ gated: number }>();
  return row?.gated === 1;
}

export async function categoryRequiresMemberAccess(
  db: D1Database,
  categoryId: number,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT members_only FROM categories WHERE id = ?')
    .bind(categoryId)
    .first<{ members_only: number }>();
  return row?.members_only === 1;
}

/** Paths that remain reachable without a member session in store-wide mode. */
export function isMemberPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/api/member-login' ||
    pathname === '/api/member-logout' ||
    pathname === '/api/webhook' ||
    pathname.startsWith('/api/webhook/') ||
    pathname === '/api/health' ||
    pathname.startsWith('/admin') ||
    pathname.startsWith('/api/admin') ||
    pathname.startsWith('/_') ||
    pathname === '/favicon.ico' ||
    pathname === '/favicon.svg' ||
    pathname === '/robots.txt' ||
    pathname === '/apple-touch-icon.png' ||
    pathname === '/apple-touch-icon-precomposed.png'
  );
}
