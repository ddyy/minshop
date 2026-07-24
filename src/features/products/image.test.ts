import { describe, it, expect } from 'vitest';
import { validateImage, productImageUrl } from './image';

describe('productImageUrl', () => {
  it('points at the R2-served object when there is a key', () => {
    expect(productImageUrl('products/abc.png')).toBe('/images/products/abc.png');
  });

  it('falls back to the placeholder when there is no image', () => {
    expect(productImageUrl(null)).toBe('/placeholder.png');
  });

  it('serves from an absolute base (R2 domain) when configured', () => {
    expect(productImageUrl('products/abc.png', 'https://images.example.com')).toBe(
      'https://images.example.com/products/abc.png',
    );
  });
});

function file(type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], 'x', { type });
}

describe('validateImage', () => {
  it('accepts the supported image types under the size limit', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(validateImage(file(type, 1024))).toBeNull();
    }
  });

  it('rejects a non-image type', () => {
    expect(validateImage(file('application/pdf', 1024))).toMatch(/JPEG|PNG|WebP|GIF/);
  });

  it('rejects files larger than 5 MB', () => {
    expect(validateImage(file('image/png', 5 * 1024 * 1024 + 1))).toMatch(/5 MB/);
  });
});
