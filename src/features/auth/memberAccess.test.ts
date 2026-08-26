import { describe, expect, it } from 'vitest';
import { isMemberPublicPath, memberAccessMode, publicProductVisibilitySql } from './memberAccess';

describe('memberAccessMode', () => {
  it('defaults to off', () => {
    expect(memberAccessMode(undefined)).toBe('off');
    expect(memberAccessMode({ memberAccessMode: 'store' } as never)).toBe('store');
  });
});

describe('isMemberPublicPath', () => {
  it('allows login, webhooks, and admin without a session', () => {
    expect(isMemberPublicPath('/login')).toBe(true);
    expect(isMemberPublicPath('/api/webhook/stripe')).toBe(true);
    expect(isMemberPublicPath('/admin/products')).toBe(true);
    expect(isMemberPublicPath('/products/tee')).toBe(false);
    expect(isMemberPublicPath('/api/products')).toBe(false);
  });
});

describe('publicProductVisibilitySql', () => {
  it('excludes product and category flags', () => {
    expect(publicProductVisibilitySql('p')).toContain('p.members_only = 0');
    expect(publicProductVisibilitySql('p')).toContain('c.members_only = 1');
  });
});
