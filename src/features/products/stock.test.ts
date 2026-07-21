import { describe, it, expect } from 'vitest';
import { stockState, LOW_STOCK } from './stock';

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
