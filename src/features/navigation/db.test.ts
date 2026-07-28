import { describe, it, expect } from 'vitest';
import {
  resolveMenuHref,
  toMenuItem,
  groupMenus,
  visibleItems,
  normalizeLabel,
  isMenuLocation,
  isMenuTargetType,
  isSingleton,
  MENU_CAPS,
  MENU_ITEMS_SQL,
  MAX_MENU_LABEL,
  type MenuItemRow,
} from './db';

const row = (over: Partial<MenuItemRow> = {}): MenuItemRow => ({
  id: 1,
  public_id: 'nav_f4ks9tw2mh',
  location: 'header',
  target_type: 'page',
  target_id: 7,
  position: 0,
  label: null,
  target_name: 'About',
  target_slug: 'about',
  available: 1,
  ...over,
});

describe('resolveMenuHref', () => {
  it('sends Home to the root', () => {
    expect(resolveMenuHref('home', null, null)).toBe('/');
    expect(resolveMenuHref('home', null, 'page:3')).toBe('/');
  });

  // The catalog moves when / is taken over; reusing catalogPath keeps this rule
  // in one place rather than restating it here.
  it('follows the catalog as the home page changes', () => {
    expect(resolveMenuHref('catalog', null, null)).toBe('/');
    expect(resolveMenuHref('catalog', null, 'page:3')).toBe('/products');
  });

  it('builds plural object routes from the slug', () => {
    expect(resolveMenuHref('page', 'about', null)).toBe('/pages/about');
    expect(resolveMenuHref('product', 'beanie', null)).toBe('/products/beanie');
    expect(resolveMenuHref('category', 'hats', null)).toBe('/categories/hats');
  });
});

describe('label fallback', () => {
  it('prefers an explicit label over the target name', () => {
    expect(toMenuItem(row({ label: 'Our story' }), null).text).toBe('Our story');
  });

  it('falls back to the target name when unset', () => {
    expect(toMenuItem(row(), null).text).toBe('About');
  });

  // Without singleton defaults in the query, COALESCE(NULL, NULL) renders an
  // empty <a> — a link that exists but cannot be seen or clicked.
  it('gives singletons a name so they never render empty', () => {
    const home = toMenuItem(
      row({ target_type: 'home', target_id: null, target_name: 'Home', target_slug: null }),
      null,
    );
    const catalog = toMenuItem(
      row({ target_type: 'catalog', target_id: null, target_name: 'Shop', target_slug: null }),
      null,
    );
    expect(home.text).toBe('Home');
    expect(catalog.text).toBe('Shop');
  });
});

describe('normalizeLabel', () => {
  it('stores blank input as NULL so COALESCE can fall back', () => {
    expect(normalizeLabel('')).toBeNull();
    expect(normalizeLabel('   ')).toBeNull();
    expect(normalizeLabel(null)).toBeNull();
    expect(normalizeLabel(undefined)).toBeNull();
  });

  it('trims and bounds the length', () => {
    expect(normalizeLabel('  Shop  ')).toBe('Shop');
    expect(normalizeLabel('x'.repeat(200))).toHaveLength(MAX_MENU_LABEL);
  });
});

describe('groupMenus', () => {
  it('splits locations and preserves order', () => {
    const menus = groupMenus(
      [
        row({ id: 1, location: 'header', position: 0, target_name: 'A' }),
        row({ id: 2, location: 'footer', position: 0, target_name: 'B' }),
        row({ id: 3, location: 'header', position: 1, target_name: 'C' }),
      ],
      null,
    );
    expect(menus.header.map((i) => i.text)).toEqual(['A', 'C']);
    expect(menus.footer.map((i) => i.text)).toEqual(['B']);
  });

  it('returns both menus even when empty', () => {
    expect(groupMenus([], null)).toEqual({ header: [], footer: [] });
  });
});

describe('visibleItems', () => {
  it('drops unavailable targets rather than rendering dead links', () => {
    const items = groupMenus(
      [
        row({ id: 1, target_name: 'Live', available: 1 }),
        row({ id: 2, target_name: 'Draft', available: 0 }),
      ],
      null,
    ).header;
    expect(visibleItems(items).map((i) => i.text)).toEqual(['Live']);
  });

  it('drops a nameless item, which would render as an invisible link', () => {
    const items = groupMenus([row({ target_name: null, available: 1 })], null).header;
    expect(visibleItems(items)).toHaveLength(0);
  });
});

describe('guards', () => {
  it('accepts only real locations and target types', () => {
    expect(isMenuLocation('header')).toBe(true);
    expect(isMenuLocation('sidebar')).toBe(false);
    expect(isMenuTargetType('category')).toBe(true);
    expect(isMenuTargetType('url')).toBe(false);
    // Object.prototype keys must not pass — `in` would have accepted these.
    expect(isMenuTargetType('toString')).toBe(false);
    expect(isMenuLocation('constructor')).toBe(false);
  });

  it('knows which targets are singletons', () => {
    expect(isSingleton('home')).toBe(true);
    expect(isSingleton('catalog')).toBe(true);
    expect(isSingleton('page')).toBe(false);
  });
});

describe('MENU_ITEMS_SQL', () => {
  // The read ceiling is what actually protects the hot path; the admin guard only
  // covers the one code path that honours it.
  it('bounds each location before joining, using the caps', () => {
    expect(MENU_ITEMS_SQL).toContain(`LIMIT ${MENU_CAPS.header}`);
    expect(MENU_ITEMS_SQL).toContain(`LIMIT ${MENU_CAPS.footer}`);
    // Both LIMITs must sit inside subqueries, not on the outer statement, or the
    // whole table is still read and ranked on every request.
    expect(MENU_ITEMS_SQL).toContain('UNION ALL');
    expect(MENU_ITEMS_SQL.trimEnd().endsWith('ORDER BY mi.location, mi.position, mi.id')).toBe(true);
  });

  it('keeps the header cap at what a single header row can hold', () => {
    expect(MENU_CAPS.header).toBeLessThanOrEqual(6);
    expect(MENU_CAPS.footer).toBe(50); // matches MAX_FOOTER_PAGE_LINKS: seed is lossless
  });
});
