import { describe, it, expect } from 'vitest';
import { orderByClause, STORE_SORTS } from './sort';

describe('products orderByClause', () => {
  it('defaults to created_at DESC (with an id tiebreak) when no params', () => {
    expect(orderByClause(null, null)).toBe('created_at DESC, id DESC');
  });

  it('honors a custom fallback when sort/dir are absent', () => {
    expect(orderByClause(null, null, { col: 'price_cents', dir: 'ASC' })).toBe(
      'price_cents ASC, id ASC',
    );
  });

  it('maps whitelisted params to fixed columns (+ id tiebreak in the same direction)', () => {
    expect(orderByClause('price', 'asc')).toBe('price_cents ASC, id ASC');
    expect(orderByClause('stock', 'desc')).toBe('stock DESC, id DESC');
    expect(orderByClause('sold', 'desc')).toBe('sold DESC, id DESC');
    expect(orderByClause('newest', 'desc')).toBe('created_at DESC, id DESC');
  });

  it('makes "Newest" ascending and descending actually differ', () => {
    expect(orderByClause('newest', 'asc')).not.toBe(orderByClause('newest', 'desc'));
  });

  it('adds COLLATE NOCASE only for name', () => {
    expect(orderByClause('name', 'asc')).toBe('name COLLATE NOCASE ASC, id ASC');
    expect(orderByClause('price', 'asc')).toBe('price_cents ASC, id ASC');
  });

  it('does not double up the tiebreak when sorting by id itself', () => {
    expect(orderByClause('id', 'desc')).toBe('id DESC');
    expect(orderByClause('bogus', 'desc', { col: 'id', dir: 'ASC' })).toBe('id DESC');
  });

  it('ignores unknown / injected sort columns and falls back', () => {
    expect(orderByClause('price_cents; DROP TABLE products;--', 'asc')).toBe(
      'created_at ASC, id ASC',
    );
  });

  it('exposes storefront presets that all resolve to safe clauses', () => {
    for (const s of STORE_SORTS) {
      const clause = orderByClause(s.sort, s.dir);
      expect(clause).toMatch(/^[a-z_]+( COLLATE NOCASE)? (ASC|DESC)(, id (ASC|DESC))?$/);
    }
  });
});
