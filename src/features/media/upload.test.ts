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
    expect(mediaKeyFor(file('image/webp', 1))).toMatch(/^media\/[0-9a-f]{20}\.webp$/);
    expect(mediaKeyFor(file('image/jpeg', 1))).toMatch(/^media\/[0-9a-f]{20}\.jpg$/);
  });

  it('never reuses a key, so /images/* can stay immutable', () => {
    const same = file('image/png', 1, 'same-name.png');
    expect(mediaKeyFor(same)).not.toBe(mediaKeyFor(same));
  });

  // Cloudflare's observability pipeline replaces any run of ID characters in a
  // request URL that reads like a credential — 32+ hex digits, or 21+ characters
  // mixing upper, lower and digits. A key above either line logs as
  // `/images/media/REDACTED.webp` and cannot be traced back to a file. This is
  // the guard against someone lengthening the key and quietly losing that.
  it('stays under the length Cloudflare redacts from request logs', () => {
    const id = mediaKeyFor(file('image/webp', 1)).slice('media/'.length).split('.')[0];
    expect(id.length).toBeLessThanOrEqual(20);
    expect(id).toMatch(/^[0-9a-f]+$/); // no uppercase: also below the base64 rule
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
