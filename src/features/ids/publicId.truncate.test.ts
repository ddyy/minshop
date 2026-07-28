import { describe, it, expect } from 'vitest';
import {
  truncatePublicId,
  publicIdDisplayLength,
  generatePublicId,
} from './publicId';

describe('truncatePublicId', () => {
  const WIDTH = publicIdDisplayLength('order');

  it('is 14 for orders: "ord" + "_" + a 10-char token', () => {
    expect(WIDTH).toBe(14);
  });

  it('leaves a current-format ID untouched', () => {
    const id = generatePublicId('order');
    expect(id).toHaveLength(WIDTH);
    expect(truncatePublicId(id, 'order')).toBe(id);
  });

  it('shortens a legacy 32-char hex ID to the same width', () => {
    const legacy = 'a'.repeat(32);
    const out = truncatePublicId(legacy, 'order');
    expect(out).toHaveLength(WIDTH);
    expect(out.endsWith('…')).toBe(true);
  });

  it('shortens a legacy UUID to the same width', () => {
    const out = truncatePublicId('3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'order');
    expect(out).toHaveLength(WIDTH);
  });

  it('counts the ellipsis inside the budget so a column stays aligned', () => {
    // A wider result than a real ID would defeat the point of truncating.
    const legacy = truncatePublicId('b'.repeat(36), 'order');
    expect(legacy.length).toBe(generatePublicId('order').length);
  });

  it('adapts to each kind rather than hardcoding a width', () => {
    expect(publicIdDisplayLength('refund')).toBe(15); // "rfnd" is a char longer
    expect(truncatePublicId('c'.repeat(32), 'refund')).toHaveLength(15);
  });
});
