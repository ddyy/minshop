import { describe, it, expect } from 'vitest';
import { orderByClause } from './sort';

describe('orders orderByClause', () => {
  it('defaults to created_at DESC (with an id tiebreak) when no params', () => {
    expect(orderByClause(null, null)).toBe('created_at DESC, id DESC');
  });

  it('maps whitelisted params to fixed columns (+ id tiebreak in the same direction)', () => {
    expect(orderByClause('order', 'asc')).toBe('id ASC'); // sorting by id: no extra tiebreak
    expect(orderByClause('total', 'desc')).toBe('amount_total_cents DESC, id DESC');
    expect(orderByClause('status', 'asc')).toBe('status ASC, id ASC');
    expect(orderByClause('fulfillment', 'desc')).toBe('fulfillment_status DESC, id DESC');
    expect(orderByClause('when', 'asc')).toBe('created_at ASC, id ASC');
  });

  it('makes low-cardinality columns (status) flip asc vs desc', () => {
    expect(orderByClause('status', 'asc')).not.toBe(orderByClause('status', 'desc'));
  });

  it('adds COLLATE NOCASE only for email', () => {
    expect(orderByClause('email', 'asc')).toBe('email COLLATE NOCASE ASC, id ASC');
    expect(orderByClause('total', 'asc')).toBe('amount_total_cents ASC, id ASC');
  });

  it('normalizes direction case and rejects junk to DESC', () => {
    expect(orderByClause('total', 'ASC')).toBe('amount_total_cents ASC, id ASC');
    expect(orderByClause('total', 'sideways')).toBe('amount_total_cents DESC, id DESC');
    expect(orderByClause('total', '')).toBe('amount_total_cents DESC, id DESC');
  });

  it('ignores unknown / injected sort columns (no user input reaches SQL)', () => {
    expect(orderByClause('amount_total_cents; DROP TABLE orders;--', 'asc')).toBe(
      'created_at ASC, id ASC',
    );
    expect(orderByClause('nonexistent', 'desc')).toBe('created_at DESC, id DESC');
    expect(orderByClause('1=1', 'asc')).toBe('created_at ASC, id ASC');
  });
});
