import { describe, expect, it, vi } from 'vitest';
import { createR2Storage } from './r2';

describe('R2 storage metadata', () => {
  it('honors private cache metadata for deliverables', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const storage = createR2Storage({ put } as never);
    await storage.put('deliverables/key/file.pdf', new ArrayBuffer(1), 'application/pdf', {
      cacheControl: 'private, no-store',
    });
    expect(put).toHaveBeenCalledWith('deliverables/key/file.pdf', expect.any(ArrayBuffer), {
      httpMetadata: { contentType: 'application/pdf', cacheControl: 'private, no-store' },
    });
  });

  it('keeps the existing immutable public default for images', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const storage = createR2Storage({ put } as never);
    await storage.put('products/key.webp', new ArrayBuffer(1), 'image/webp');
    expect(put.mock.calls[0][2].httpMetadata.cacheControl).toBe(
      'public, max-age=31536000, immutable',
    );
  });
});
