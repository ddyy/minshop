import { describe, it, expect } from 'vitest';
import {
  onDemandImageDeliveryAvailable,
  productEmailImageUrl,
  productImageSources,
  productImageUrl,
  validateImage,
} from './image';

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

describe('productImageSources', () => {
  it('keeps original delivery byte-for-byte compatible', () => {
    expect(
      productImageSources('products/abc.png', {
        baseUrl: 'https://images.example.com',
        delivery: 'original',
        usage: 'detail',
      }),
    ).toEqual({ src: 'https://images.example.com/products/abc.png' });
  });

  it('builds the bounded responsive ladder with a legacy cache revision', () => {
    const sources = productImageSources('products/brass-pen.jpg', {
      baseUrl: 'https://images.example.com',
      delivery: 'cloudflare',
      usage: 'card',
    });

    expect(sources.src).toContain('/cdn-cgi/image/width=384,');
    expect(sources.src).toContain(
      'https://images.example.com/products/brass-pen.jpg?v=1',
    );
    expect(sources.src).toContain('fit=scale-down,format=auto,quality=82,onerror=redirect');
    expect(sources.srcset?.split(', /cdn-cgi/image/')).toHaveLength(4);
    for (const width of [128, 384, 768, 1024]) {
      expect(sources.srcset).toContain(`width=${width},`);
      expect(sources.srcset).toContain(`${width}w`);
    }
    expect(sources.sizes).toContain('384px');
  });

  // Every upload since the media library, and every object after the key rename,
  // lives under media/. Gating transforms on products/ alone silently served the
  // full-size original for all of them.
  it('builds the same ladder for media/ keys', () => {
    const sources = productImageSources('media/a9468bf665b439711b62.webp', {
      baseUrl: 'https://images.example.com',
      delivery: 'cloudflare',
      usage: 'card',
    });

    expect(sources.srcset?.split(', /cdn-cgi/image/')).toHaveLength(4);
    expect(sources.src).toContain('/cdn-cgi/image/width=384,');
    expect(sources.src).toContain('https://images.example.com/media/a9468bf665b439711b62.webp?v=1');
  });

  it('still refuses keys outside the store\'s own prefixes', () => {
    for (const key of [
      'evil/abc.png',
      '/etc/passwd',
      'https://evil.example/a.jpg',
      'products/../private/a.jpg',
      'media/../../secret.png',
    ]) {
      const sources = productImageSources(key, {
        baseUrl: 'https://images.example.com',
        delivery: 'cloudflare',
      });
      expect(sources.srcset).toBeUndefined();
    }
  });

  it('uses detail and thumbnail fallbacks appropriate to their usage', () => {
    const detail = productImageSources('products/abc.png', {
      baseUrl: 'https://images.example.com',
      delivery: 'cloudflare',
      usage: 'detail',
    });
    const thumbnail = productImageSources('products/abc.png', {
      baseUrl: 'https://images.example.com',
      delivery: 'cloudflare',
      usage: 'thumbnail',
      sizes: '64px',
    });

    expect(detail.src).toContain('width=768');
    expect(thumbnail.src).toContain('width=128');
    expect(thumbnail.sizes).toBe('64px');
  });

  it('falls back instead of transforming untrusted or path-traversing keys', () => {
    for (const key of ['https://evil.example/a.jpg', 'products/../private/a.jpg']) {
      expect(
        productImageSources(key, {
          baseUrl: 'https://images.example.com',
          delivery: 'cloudflare',
        }),
      ).toEqual({ src: `https://images.example.com/${key}` });
    }
  });

  it('requires an HTTPS image base before the dashboard can offer on-demand delivery', () => {
    expect(onDemandImageDeliveryAvailable('https://images.example.com')).toBe(true);
    expect(onDemandImageDeliveryAvailable('http://images.example.com')).toBe(false);
    expect(onDemandImageDeliveryAvailable('not a url')).toBe(false);
  });

  it('builds an absolute square JPEG thumbnail for email', () => {
    const url = productEmailImageUrl(
      'products/abc.png',
      'https://shop.example.com',
      'https://images.example.com',
      'cloudflare',
    );
    expect(url).toContain('https://shop.example.com/cdn-cgi/image/');
    expect(url).toContain('width=96,height=96,fit=cover,format=jpeg,quality=80');
    expect(url).toContain('https://images.example.com/products/abc.png?v=1');
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
