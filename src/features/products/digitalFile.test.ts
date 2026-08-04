import { describe, expect, it, vi } from 'vitest';
import { uploadDigitalFile, validateDigitalFile } from './digitalFile';
import type { StorageProvider } from '../storage/provider';

describe('digital deliverables', () => {
  it('requires an allowed MIME and matching extension', () => {
    expect(validateDigitalFile(new File(['pdf'], 'guide.pdf', { type: 'application/pdf' }))).toBeNull();
    expect(validateDigitalFile(new File(['pdf'], 'guide.zip', { type: 'application/pdf' }))).toMatch(/PDF/);
    expect(validateDigitalFile(new File([], 'empty.pdf', { type: 'application/pdf' }))).toMatch(/non-empty/);
  });

  it('uploads under an immutable unique key with private metadata', async () => {
    const put = vi.fn<StorageProvider['put']>();
    const storage: StorageProvider = { put, get: vi.fn(), delete: vi.fn() };
    const file = new File(['hello'], 'My guide.pdf', { type: 'application/pdf' });
    const saved = await uploadDigitalFile(storage, file);

    expect(saved).toMatchObject({ name: 'My guide.pdf', mime: 'application/pdf', size: 5 });
    expect(saved.key).toMatch(/^deliverables\/[0-9a-f-]+\/My-guide\.pdf$/);
    expect(put).toHaveBeenCalledWith(
      saved.key,
      expect.any(ArrayBuffer),
      'application/pdf',
      { cacheControl: 'private, no-store' },
    );
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
