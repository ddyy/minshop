import { describe, it, expect } from 'vitest';
import { toFtsQuery, editDistance } from './search';

describe('toFtsQuery', () => {
  it('prefix-matches each token', () => {
    expect(toFtsQuery('red mug')).toBe('red* mug*');
  });

  it('strips FTS5 special characters that would cause syntax errors', () => {
    expect(toFtsQuery('"tee-shirt!')).toBe('tee* shirt*');
  });

  it('lowercases', () => {
    expect(toFtsQuery('MUG')).toBe('mug*');
  });

  it('returns null for empty or symbol-only input', () => {
    expect(toFtsQuery('   ')).toBeNull();
    expect(toFtsQuery('!!!')).toBeNull();
  });
});

describe('editDistance', () => {
  it('is 0 for identical strings', () => {
    expect(editDistance('mug', 'mug')).toBe(0);
  });

  it('counts single edits (insert/substitute)', () => {
    expect(editDistance('mug', 'moug')).toBe(1);
    expect(editDistance('comfy', 'comfey')).toBe(1);
  });

  it('matches the classic kitten→sitting example', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('handles empty strings', () => {
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('abc', '')).toBe(3);
  });
});
