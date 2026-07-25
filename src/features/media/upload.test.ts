import { describe, it, expect } from 'vitest';
import { validateUpload, mediaKeyFor } from './upload';
import { mediaUrl } from './url';

const file = (type: string, size: number, name = 'photo.png') =>
  new File([new Uint8Array(size)], name, { type });

describe('validateUpload', () => {
  it('accepts the four supported raster types', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(validateUpload(file(type, 1024))).toBeNull();
    }
  });

  it('rejects SVG, which would execute script from the store origin', () => {
    expect(validateUpload(file('image/svg+xml', 1024))).toMatch(/JPEG|PNG|WebP|GIF/);
  });

  it('rejects non-images', () => {
    expect(validateUpload(file('application/pdf', 1024))).toMatch(/JPEG|PNG|WebP|GIF/);
  });

  it('rejects files over 5 MB', () => {
    expect(validateUpload(file('image/png', 5 * 1024 * 1024 + 1))).toMatch(/5 MB/);
    expect(validateUpload(file('image/png', 5 * 1024 * 1024))).toBeNull();
  });
});

describe('mediaKeyFor', () => {
  it('namespaces under media/ with an extension matching the type', () => {
    expect(mediaKeyFor(file('image/webp', 1))).toMatch(/^media\/[0-9a-f-]{36}\.webp$/);
    expect(mediaKeyFor(file('image/jpeg', 1))).toMatch(/^media\/[0-9a-f-]{36}\.jpg$/);
  });

  it('never reuses a key, so /images/* can stay immutable', () => {
    const same = file('image/png', 1, 'same-name.png');
    expect(mediaKeyFor(same)).not.toBe(mediaKeyFor(same));
  });
});

describe('mediaUrl', () => {
  it('serves through the Worker route by default', () => {
    expect(mediaUrl('media/abc.webp')).toBe('/images/media/abc.webp');
  });

  it('uses the configured image origin when one is set', () => {
    expect(mediaUrl('media/abc.webp', 'https://images.example.com')).toBe(
      'https://images.example.com/media/abc.webp',
    );
  });

  it('produces the same URL for legacy product keys', () => {
    expect(mediaUrl('products/old.jpg')).toBe('/images/products/old.jpg');
  });
});
