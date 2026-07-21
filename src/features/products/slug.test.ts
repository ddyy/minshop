import { describe, it, expect } from 'vitest';
import { slugify } from './slug';

describe('slugify', () => {
  it('lowercases and dashes spaces', () => {
    expect(slugify('Sample Tee')).toBe('sample-tee');
  });

  it('strips punctuation and apostrophes', () => {
    expect(slugify("Mom's Best Mug!")).toBe('moms-best-mug');
  });

  it('collapses repeats and trims leading/trailing dashes', () => {
    expect(slugify('  Hello---World  ')).toBe('hello-world');
  });

  it('strips diacritics', () => {
    expect(slugify('Café Crème')).toBe('cafe-creme');
  });

  it('falls back to "product" for empty or symbol-only input', () => {
    expect(slugify('!!!')).toBe('product');
    expect(slugify('')).toBe('product');
  });

  it('caps length at 80 characters', () => {
    expect(slugify('a'.repeat(200))).toHaveLength(80);
  });
});
