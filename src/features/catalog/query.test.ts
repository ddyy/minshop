import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CATALOG_LIMIT,
  MAX_CATALOG_LIMIT,
  parseCatalogListQuery,
} from './query';

const parse = (query: string) => parseCatalogListQuery(new URLSearchParams(query));

describe('parseCatalogListQuery', () => {
  it('uses stable defaults for missing and blank values', () => {
    expect(parse('')).toEqual({ query: '', limit: DEFAULT_CATALOG_LIMIT, offset: 0 });
    expect(parse('limit=&offset=')).toEqual({
      query: '',
      limit: DEFAULT_CATALOG_LIMIT,
      offset: 0,
    });
  });

  it('clamps and truncates numeric paging input', () => {
    expect(parse('limit=999&offset=-4')).toMatchObject({
      limit: MAX_CATALOG_LIMIT,
      offset: 0,
    });
    expect(parse('limit=3.9&offset=8.8')).toMatchObject({ limit: 3, offset: 8 });
  });

  it('normalizes and bounds the search query', () => {
    expect(parse('q=%20wireless%20%20charger%20').query).toBe('wireless charger');
  });
});
