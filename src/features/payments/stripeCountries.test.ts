import { describe, it, expect } from 'vitest';
import { COUNTRY_CODES } from '../shipping/countries';
import { STRIPE_UNSUPPORTED, stripeAllowedCountries } from './stripeCountries';

describe('stripeAllowedCountries', () => {
  it('passes explicit zone countries straight through', () => {
    expect(stripeAllowedCountries(['US', 'ca'], false)).toEqual(['US', 'CA']);
  });

  it('expands a catch-all instead of sending an empty list', () => {
    // An empty `allowed_countries` is a Stripe API error, not "anywhere" — a
    // catch-all-only store would fail at session creation without this.
    const expanded = stripeAllowedCountries([], true);
    expect(expanded.length).toBeGreaterThan(200);
    expect(expanded).toContain('CA');
    expect(expanded).toContain('JP');
  });

  it('drops only the codes the pinned SDK rejects', () => {
    const expanded = stripeAllowedCountries([], true);
    for (const code of STRIPE_UNSUPPORTED) expect(expanded).not.toContain(code);
    expect(expanded).toHaveLength(COUNTRY_CODES.length - STRIPE_UNSUPPORTED.size);
    // Remote territories are ordinary destinations for Stripe; excluding them by
    // guesswork silently removed valid ones.
    for (const code of ['AQ', 'BV', 'EH', 'GS', 'IO', 'PN', 'SJ', 'TF']) {
      expect(expanded).toContain(code);
    }
  });

  it('still filters an explicit list that names an unsupported code', () => {
    expect(stripeAllowedCountries(['US', 'CU'], false)).toEqual(['US']);
  });
});
