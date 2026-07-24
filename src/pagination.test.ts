import { describe, it, expect } from 'vitest';
import { MAX_PUBLIC_PAGE, paginate, queryHref, requestedPage } from './pagination';

const sp = (q: string) => new URLSearchParams(q);

describe('paginate', () => {
  it('defaults to page 1 with no ?page', () => {
    const p = paginate(sp(''), 100, 20);
    expect(p).toMatchObject({ page: 1, offset: 0, totalPages: 5, total: 100, pageSize: 20 });
  });

  it('computes offset from the page', () => {
    expect(paginate(sp('page=3'), 100, 20).offset).toBe(40);
  });

  it('clamps an over-large page to the last page', () => {
    const p = paginate(sp('page=999'), 100, 20);
    expect(p.page).toBe(5);
    expect(p.offset).toBe(80);
  });

  it('rejects zero, negative, and non-integer pages to page 1', () => {
    expect(paginate(sp('page=0'), 100, 20).page).toBe(1);
    expect(paginate(sp('page=-4'), 100, 20).page).toBe(1);
    expect(paginate(sp('page=2.5'), 100, 20).page).toBe(1);
    expect(paginate(sp('page=abc'), 100, 20).page).toBe(1);
  });

  it('always has at least one page, even with zero results', () => {
    const p = paginate(sp('page=1'), 0, 20);
    expect(p.totalPages).toBe(1);
    expect(p.offset).toBe(0);
  });

  it('can bound public page numbers before they become cache keys or offsets', () => {
    expect(requestedPage(sp('page=999999'), MAX_PUBLIC_PAGE)).toBe(MAX_PUBLIC_PAGE);
    const page = paginate(sp('page=999999'), 1_000_000, 20, 100);
    expect(page.page).toBe(100);
    expect(page.totalPages).toBe(100);
  });
});

describe('queryHref', () => {
  it('returns the bare base when all params are empty', () => {
    expect(queryHref('/admin/orders', { sort: null, dir: undefined, page: '' })).toBe(
      '/admin/orders',
    );
  });

  it('drops empty/undefined/null params and keeps the rest', () => {
    expect(queryHref('/admin/orders', { sort: 'total', dir: undefined, page: 2 })).toBe(
      '/admin/orders?sort=total&page=2',
    );
  });

  it('coerces numbers to strings', () => {
    expect(queryHref('/p', { page: 3 })).toBe('/p?page=3');
  });

  it('keeps a zero value (only empty-string/null/undefined are dropped)', () => {
    expect(queryHref('/p', { n: 0 })).toBe('/p?n=0');
  });
});
