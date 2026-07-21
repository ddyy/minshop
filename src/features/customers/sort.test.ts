import { describe, it, expect } from 'vitest';
import { orderByClause } from './sort';

describe('customers orderByClause', () => {
  it('defaults to lifetime_cents DESC (with an email tiebreak) when no params', () => {
    expect(orderByClause(null, null)).toBe('lifetime_cents DESC, email DESC');
  });

  it('maps whitelisted params to SELECT aliases (+ email tiebreak in the same direction)', () => {
    expect(orderByClause('orders', 'desc')).toBe('orders DESC, email DESC');
    expect(orderByClause('lifetime', 'asc')).toBe('lifetime_cents ASC, email ASC');
    expect(orderByClause('last', 'desc')).toBe('last_order DESC, email DESC');
  });

  it('makes a tie-prone column (orders count) flip asc vs desc', () => {
    expect(orderByClause('orders', 'asc')).not.toBe(orderByClause('orders', 'desc'));
  });

  it('adds COLLATE NOCASE only for email, and skips the tiebreak when sorting by email', () => {
    expect(orderByClause('email', 'asc')).toBe('email COLLATE NOCASE ASC');
    expect(orderByClause('orders', 'asc')).toBe('orders ASC, email ASC');
  });

  it('ignores unknown / injected sort columns', () => {
    expect(orderByClause('lifetime_cents); DROP TABLE orders;--', 'asc')).toBe(
      'lifetime_cents ASC, email ASC',
    );
    expect(orderByClause('bogus', 'desc')).toBe('lifetime_cents DESC, email DESC');
  });

  it('rejects junk direction to DESC', () => {
    expect(orderByClause('orders', 'up')).toBe('orders DESC, email DESC');
  });
});
