import { describe, it, expect } from 'vitest';
import { parsePageForm } from './form';
import { pageSlugify } from './slug';

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

describe('parsePageForm', () => {
  it('accepts a minimal page', () => {
    const parsed = parsePageForm(form({ title: 'About us' }));
    expect(parsed).toEqual({
      data: {
        title: 'About us',
        slug: '',
        body_markdown: '',
        published: 0,
        layout: 'standard',
      },
    });
  });

  it('accepts a known layout preset', () => {
    expect(parsePageForm(form({ title: 'A', layout: 'wide' }))).toHaveProperty(
      'data.layout',
      'wide',
    );
  });

  it('falls back to the default layout for an unknown preset', () => {
    expect(parsePageForm(form({ title: 'A', layout: 'nope' }))).toHaveProperty(
      'data.layout',
      'standard',
    );
  });

  it('requires a title', () => {
    expect(parsePageForm(form({ title: '   ' }))).toEqual({ error: 'Title is required.' });
  });

  it('rejects an over-long title', () => {
    const result = parsePageForm(form({ title: 'x'.repeat(121) }));
    expect(result).toHaveProperty('error');
  });

  it('accepts a title at the limit', () => {
    expect(parsePageForm(form({ title: 'x'.repeat(120) }))).toHaveProperty('data');
  });

  it('rejects a body over 100,000 characters', () => {
    const result = parsePageForm(form({ title: 'A', body_markdown: 'x'.repeat(100_001) }));
    expect(result).toHaveProperty('error');
  });

  it('treats a present checkbox as published', () => {
    const parsed = parsePageForm(form({ title: 'A', published: 'on' }));
    expect(parsed).toHaveProperty('data.published', 1);
  });

  it('treats an absent checkbox as draft', () => {
    expect(parsePageForm(form({ title: 'A' }))).toHaveProperty('data.published', 0);
  });

  it('preserves body whitespace, which is meaningful in Markdown', () => {
    const parsed = parsePageForm(form({ title: 'A', body_markdown: '  indented\n\n- list' }));
    expect(parsed).toHaveProperty('data.body_markdown', '  indented\n\n- list');
  });
});

describe('pageSlugify', () => {
  it('slugifies a title', () => {
    expect(pageSlugify('Shipping & Returns')).toBe('shipping-returns');
  });

  it('falls back to `page`, not the product helper default', () => {
    // slugify() returns 'product' for input that reduces to nothing, which would
    // be a confusing slug for a content page.
    expect(pageSlugify('!!!')).toBe('page');
    expect(pageSlugify('')).toBe('page');
  });

  it('still honours a title that genuinely says "product"', () => {
    expect(pageSlugify('Product care')).toBe('product-care');
    expect(pageSlugify('Product')).toBe('product');
  });
});
