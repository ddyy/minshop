import { describe, it, expect } from 'vitest';
import {
  parseHomeTarget,
  serializeHomeTarget,
  DEFAULT_HOME,
  catalogPath,
} from './home';

describe('parseHomeTarget', () => {
  it('defaults to the product list when unset', () => {
    expect(parseHomeTarget(null)).toEqual(DEFAULT_HOME);
    expect(parseHomeTarget(undefined)).toEqual(DEFAULT_HOME);
    expect(parseHomeTarget('')).toEqual(DEFAULT_HOME);
  });

  it('reads a page target', () => {
    expect(parseHomeTarget('page:7')).toEqual({ kind: 'page', id: 7 });
  });

  it('reads a product target', () => {
    expect(parseHomeTarget('product:12')).toEqual({ kind: 'product', id: 12 });
  });

  // Anything unparseable must land on the catalog rather than throwing: this
  // value decides what `/` renders, and an exception there takes the store down.
  it('falls back for an unknown kind', () => {
    expect(parseHomeTarget('category:3')).toEqual(DEFAULT_HOME);
  });

  it('falls back for a missing or non-numeric id', () => {
    expect(parseHomeTarget('page:')).toEqual(DEFAULT_HOME);
    expect(parseHomeTarget('page:abc')).toEqual(DEFAULT_HOME);
    expect(parseHomeTarget('page')).toEqual(DEFAULT_HOME);
  });

  it('falls back for ids that cannot be real rows', () => {
    expect(parseHomeTarget('page:0')).toEqual(DEFAULT_HOME);
    expect(parseHomeTarget('page:-4')).toEqual(DEFAULT_HOME);
    expect(parseHomeTarget('page:1.5')).toEqual(DEFAULT_HOME);
  });
});

describe('serializeHomeTarget', () => {
  it('stores the default as empty, so setSetting deletes the row', () => {
    expect(serializeHomeTarget({ kind: 'products' })).toBe('');
  });

  it('round-trips a page and a product', () => {
    for (const target of [
      { kind: 'page', id: 7 },
      { kind: 'product', id: 12 },
    ] as const) {
      expect(parseHomeTarget(serializeHomeTarget(target))).toEqual(target);
    }
  });
});

describe('catalogPath', () => {
  it('is / while the home page is the catalog', () => {
    expect(catalogPath(null)).toBe('/');
    expect(catalogPath('')).toBe('/');
  });

  it('is /products once the home page has been taken over', () => {
    // Otherwise "back to shop" would send the shopper to the page or the single
    // product that replaced the catalog, not to the products.
    expect(catalogPath('page:1')).toBe('/products');
    expect(catalogPath('product:9')).toBe('/products');
  });
});
