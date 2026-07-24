import { describe, it, expect } from 'vitest';
import type { Ai } from '@cloudflare/workers-types';
import { embedText, productEmbedText, selectRelatedIds, mergeSearchResults } from './vector';
import type { Product } from '../products/db';

const fakeAi = (data: unknown): Ai =>
  ({ run: async () => ({ data }) }) as unknown as Ai;

describe('embedText', () => {
  it('returns the first vector from the AI response', async () => {
    expect(await embedText(fakeAi([[0.1, 0.2, 0.3]]), 'model', 'hello')).toEqual([0.1, 0.2, 0.3]);
  });

  it('throws on an empty/missing response', async () => {
    await expect(embedText(fakeAi([]), 'm', 'x')).rejects.toThrow();
    await expect(embedText(fakeAi([[]]), 'm', 'x')).rejects.toThrow();
    await expect(embedText(fakeAi(undefined), 'm', 'x')).rejects.toThrow();
  });
});

describe('productEmbedText', () => {
  it('combines name + description', () => {
    expect(productEmbedText({ name: 'Mug', description: 'Ceramic, 12oz' })).toBe('Mug\nCeramic, 12oz');
  });
  it('uses name only when there is no description', () => {
    expect(productEmbedText({ name: 'Mug', description: null })).toBe('Mug');
  });
  it('appends a category line when category names are given', () => {
    expect(productEmbedText({ name: 'Mug', description: 'Ceramic' }, ['Kitchen', 'Drinkware'])).toBe(
      'Mug\nCeramic\nCategories: Kitchen, Drinkware',
    );
  });
  it('skips the category line when none are given', () => {
    expect(productEmbedText({ name: 'Mug', description: 'Ceramic' }, [])).toBe('Mug\nCeramic');
  });
});

describe('selectRelatedIds (vector "you may also like")', () => {
  it('excludes the source product and caps at the limit', () => {
    const matches = [{ id: '5' }, { id: '3' }, { id: '9' }, { id: '2' }];
    expect(selectRelatedIds(matches, 5, 2)).toEqual([3, 9]);
  });
  it('drops non-integer ids', () => {
    expect(selectRelatedIds([{ id: 'x' }, { id: '7' }], 1, 5)).toEqual([7]);
  });
  it('returns [] when only the source matches', () => {
    expect(selectRelatedIds([{ id: '4' }], 4, 4)).toEqual([]);
  });
});

describe('mergeSearchResults (hybrid semantic + FTS)', () => {
  const prod = (id: number) => ({ id }) as unknown as Product;

  it('puts semantic matches first, then appends FTS extras (deduped)', () => {
    const r = mergeSearchResults(
      { products: [prod(1), prod(2)], total: 2, correctedTo: null },
      { products: [prod(2), prod(3)], total: 2, correctedTo: null },
    );
    expect(r.products.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(r.total).toBe(3);
    expect(r.correctedTo).toBeNull();
  });

  it('surfaces the FTS typo correction only when semantic found nothing ("leathe" rescue)', () => {
    const r = mergeSearchResults(
      { products: [], total: 0, correctedTo: null },
      { products: [prod(5)], total: 1, correctedTo: 'leather' },
    );
    expect(r.products.map((p) => p.id)).toEqual([5]);
    expect(r.correctedTo).toBe('leather');
  });

  it('hides the correction when semantic already matched', () => {
    const r = mergeSearchResults(
      { products: [prod(1)], total: 1, correctedTo: null },
      { products: [prod(2)], total: 1, correctedTo: 'leather' },
    );
    expect(r.products.map((p) => p.id)).toEqual([1, 2]);
    expect(r.correctedTo).toBeNull();
  });
});
