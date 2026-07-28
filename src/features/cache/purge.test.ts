import { describe, expect, it, vi } from 'vitest';
import {
  purgeCacheTags,
  purgeProductCache,
  purgeStockProductCache,
  type CachePurger,
} from './purge';

const result = (success: boolean): CachePurgeResult => ({
  success,
  errors: success ? [] : [{ code: 429, message: 'rate limited' }],
});

describe('Workers cache purge', () => {
  it('purges normalized tags once on success', async () => {
    const purge = vi.fn(async () => result(true));
    await purgeCacheTags(['shell', 'catalog', 'shell'], { purge });
    expect(purge).toHaveBeenCalledOnce();
    expect(purge).toHaveBeenCalledWith({ tags: ['catalog', 'shell'] });
  });

  it('falls back to purge-everything after a rejected tag purge', async () => {
    const purge = vi
      .fn<CachePurger['purge']>()
      .mockResolvedValueOnce(result(false))
      .mockResolvedValueOnce(result(true));
    await purgeCacheTags(['catalog'], { purge });
    expect(purge.mock.calls).toEqual([
      [{ tags: ['catalog'] }],
      [{ purgeEverything: true }],
    ]);
  });

  it('throws when both purge attempts fail', async () => {
    const purge = vi.fn(async () => result(false));
    await expect(purgeCacheTags(['catalog'], { purge })).rejects.toThrow(
      'could not be invalidated',
    );
    expect(purge).toHaveBeenCalledTimes(2);
  });

  it('purges only the affected product tags', async () => {
    const purge = vi.fn(async () => result(true));
    await purgeProductCache(['prod_z', 'prod_a', 'prod_z'], { purge });
    expect(purge).toHaveBeenCalledWith({ tags: ['product:prod_a', 'product:prod_z'] });
  });

  it('does not turn a rate-limited stock transition into purge-everything', async () => {
    const purge = vi.fn(async () => result(false));
    await expect(purgeStockProductCache(['prod_a'], { purge })).resolves.toBeUndefined();
    expect(purge).toHaveBeenCalledOnce();
    expect(purge).toHaveBeenCalledWith({ tags: ['product:prod_a'] });
  });
});
