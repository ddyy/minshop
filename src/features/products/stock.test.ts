import { describe, it, expect } from 'vitest';
import { stockState, LOW_STOCK, visibleStockChanged } from './stock';

describe('stockState', () => {
  it('is "out" at zero or negative stock', () => {
    expect(stockState(0)).toBe('out');
    expect(stockState(-3)).toBe('out');
  });

  it('is "low" from 1 up to the threshold', () => {
    expect(stockState(1)).toBe('low');
    expect(stockState(LOW_STOCK)).toBe('low');
  });

  it('is "in" above the threshold', () => {
    expect(stockState(LOW_STOCK + 1)).toBe('in');
    expect(stockState(100)).toBe('in');
  });
});

describe('visibleStockChanged', () => {
  it('ignores exact product quantity changes inside one rendered bucket', () => {
    expect(visibleStockChanged(false, 17, 16)).toBe(false);
    expect(visibleStockChanged(false, 4, 3)).toBe(false);
  });

  it('detects product transitions across in, low, and out', () => {
    expect(visibleStockChanged(false, LOW_STOCK + 1, LOW_STOCK)).toBe(true);
    expect(visibleStockChanged(false, 1, 0)).toBe(true);
    expect(visibleStockChanged(false, 0, 1)).toBe(true);
  });

  it('purges a variant only when its sold-out boolean changes', () => {
    expect(visibleStockChanged(true, 3, 2)).toBe(false);
    expect(visibleStockChanged(true, 1, 0)).toBe(true);
    expect(visibleStockChanged(true, 0, 1)).toBe(true);
  });
});
