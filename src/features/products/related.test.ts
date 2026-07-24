import { describe, it, expect } from 'vitest';
import { parseRelatedIds } from './db';

// The null-vs-empty distinction drives the backfill: null means "never computed"
// (recompute in the background), [] means "computed, genuinely no neighbours"
// (leave it alone). Conflating them would either re-query Vectorize forever or
// permanently skip products that legitimately have no matches.
describe('parseRelatedIds', () => {
  it('returns null when never computed', () => {
    expect(parseRelatedIds(null)).toBeNull();
  });

  it('distinguishes a computed-but-empty list from never-computed', () => {
    expect(parseRelatedIds('[]')).toEqual([]);
  });

  it('parses stored ids in order', () => {
    expect(parseRelatedIds('[7,3,9]')).toEqual([7, 3, 9]);
  });

  it('drops non-positive and non-integer entries', () => {
    expect(parseRelatedIds('[7,0,-2,"x",3.5,9]')).toEqual([7, 9]);
  });

  it('treats malformed or non-array JSON as never-computed', () => {
    expect(parseRelatedIds('not json')).toBeNull();
    expect(parseRelatedIds('{"a":1}')).toBeNull();
  });
});
