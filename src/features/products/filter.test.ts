import { describe, it, expect } from 'vitest';
import {
  parseProductFilters,
  productFilterClause,
  hasProductFilters,
  escapeLike,
} from './filter';
import { LOW_STOCK, stockState } from './stock';

const parse = (qs: string) => parseProductFilters(new URLSearchParams(qs));

describe('parseProductFilters', () => {
  it('reads each supported filter', () => {
    expect(parse('status=inactive&stock=low&q=tee')).toEqual({
      status: 'inactive',
      stock: 'low',
      q: 'tee',
    });
  });

  it('drops values that are not on the whitelist', () => {
    expect(parse('status=archived&stock=plenty')).toEqual({
      status: null,
      stock: null,
      q: null,
    });
  });

  it('treats a blank or whitespace search as no search', () => {
    expect(parse('q=%20%20').q).toBeNull();
    expect(hasProductFilters(parse('q='))).toBe(false);
  });

  it('caps an overlong search term', () => {
    expect(parse(`q=${'x'.repeat(500)}`).q).toHaveLength(100);
  });
});

describe('escapeLike', () => {
  it('escapes wildcards so they match literally', () => {
    // Without this, searching "50%" returns every product.
    expect(escapeLike('50%')).toBe('50\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('back\\slash')).toBe('back\\\\slash');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLike('Sample Tee')).toBe('Sample Tee');
  });
});

describe('productFilterClause', () => {
  it('builds no clause when nothing is filtered', () => {
    expect(productFilterClause(parse(''))).toEqual({ where: '', params: [] });
  });

  it('binds the search term rather than interpolating it', () => {
    const { where, params } = productFilterClause(parse("q=' OR 1=1--"));
    expect(where).toBe("WHERE p.name LIKE ? ESCAPE '\\' COLLATE NOCASE");
    expect(params).toEqual(["%' OR 1=1--%"]);
  });

  it('combines filters with AND', () => {
    const { where, params } = productFilterClause(parse('status=active&stock=out&q=tee'));
    expect(where).toBe(
      "WHERE p.active = 1 AND (p.stock <= 0) AND p.name LIKE ? ESCAPE '\\' COLLATE NOCASE",
    );
    expect(params).toEqual(['%tee%']);
  });

  it('uses the same stock boundaries the badges display', () => {
    // A product badged "Low" must be one the Low filter returns, so the two
    // read from the same threshold rather than drifting apart.
    expect(productFilterClause(parse('stock=low')).where).toBe(
      `WHERE (p.stock > 0 AND p.stock <= ${LOW_STOCK})`,
    );
    expect(stockState(LOW_STOCK)).toBe('low');
    expect(productFilterClause(parse('stock=in')).where).toBe(`WHERE (p.stock > ${LOW_STOCK})`);
    expect(stockState(LOW_STOCK + 1)).toBe('in');
    expect(stockState(0)).toBe('out');
  });
});
