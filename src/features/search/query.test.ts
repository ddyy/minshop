import { describe, expect, it } from 'vitest';
import { MAX_SEARCH_QUERY_LENGTH, normalizeSearchQuery } from './query';

describe('normalizeSearchQuery', () => {
  it('trims and collapses equivalent whitespace', () => {
    expect(normalizeSearchQuery('  leather \n  notebook  ')).toBe('leather notebook');
  });

  it('bounds public search input', () => {
    expect(normalizeSearchQuery('x'.repeat(MAX_SEARCH_QUERY_LENGTH + 50))).toHaveLength(
      MAX_SEARCH_QUERY_LENGTH,
    );
  });

  it('does not split a Unicode code point at the boundary', () => {
    const result = normalizeSearchQuery(`${'x'.repeat(MAX_SEARCH_QUERY_LENGTH - 1)}😀😀`);
    expect(Array.from(result)).toHaveLength(MAX_SEARCH_QUERY_LENGTH);
    expect(result.endsWith('😀')).toBe(true);
  });

  it('preserves case for display', () => {
    expect(normalizeSearchQuery('USB-C Hub')).toBe('USB-C Hub');
  });
});
