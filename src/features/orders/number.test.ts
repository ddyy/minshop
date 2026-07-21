import { describe, it, expect } from 'vitest';
import { orderNumber } from './number';

describe('orderNumber', () => {
  const seq = { offset: 1000, step: 1, randomStep: 0 };

  it('starts at the offset for the first order', () => {
    expect(orderNumber(1, seq)).toBe(1000);
  });

  it('increments by step with no jitter', () => {
    expect(orderNumber(2, seq)).toBe(1001);
    expect(orderNumber(50, seq)).toBe(1049);
  });

  it('respects a larger step', () => {
    const cfg = { offset: 5000, step: 10, randomStep: 0 };
    expect(orderNumber(1, cfg)).toBe(5000);
    expect(orderNumber(3, cfg)).toBe(5020);
  });

  it('is deterministic with jitter (same id → same number)', () => {
    const cfg = { offset: 1000, step: 10, randomStep: 7 };
    expect(orderNumber(5, cfg)).toBe(orderNumber(5, cfg));
  });

  it('stays strictly increasing and unique when step > randomStep', () => {
    const cfg = { offset: 1000, step: 10, randomStep: 9 };
    const nums = Array.from({ length: 300 }, (_, i) => orderNumber(i + 1, cfg));
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBeGreaterThan(nums[i - 1]);
    }
    expect(new Set(nums).size).toBe(nums.length);
  });
});
