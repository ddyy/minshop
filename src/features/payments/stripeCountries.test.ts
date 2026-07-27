import { describe, it, expect } from 'vitest';
import { COUNTRY_CODES } from '../shipping/countries';
import { STRIPE_UNSUPPORTED, stripeAllowedCountries, stripeSessionDestination } from './stripeCountries';

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

describe('stripeSessionDestination', () => {
  // Two zones: an unsupported first country and a supported second. The session
  // must be pinned to the QUOTED country — never widened to the configured list,
  // which would let a US-priced session collect a Canadian address.
  const configured = ['CU', 'US'];

  it('narrows the session to exactly the quoted country', () => {
    expect(stripeSessionDestination('US', configured, false)).toEqual(['US']);
    expect(stripeSessionDestination('us', configured, false)).toEqual(['US']);
  });
  it('never returns the whole configured list', () => {
    const result = stripeSessionDestination('US', configured, false);
    expect(result).not.toContain('CU');
    expect(result).toHaveLength(1);
  });
  it('refuses a country outside the configured zones', () => {
    expect(stripeSessionDestination('CA', configured, false)).toBeNull();
  });
  it('refuses a configured but Stripe-unsupported country', () => {
    expect(stripeSessionDestination('CU', configured, false)).toBeNull();
  });
  it('refuses a crafted non-country code', () => {
    expect(stripeSessionDestination('ZZ', configured, false)).toBeNull();
    expect(stripeSessionDestination('', configured, false)).toBeNull();
  });
  it('refuses malformed shapes instead of guessing a country', () => {
    // A present-but-wrong value is a claim about the destination; the routes pass
    // it through verbatim so it lands here and is refused, never replaced with a
    // fallback the shopper did not choose.
    expect(stripeSessionDestination('USA', configured, false)).toBeNull();
    expect(stripeSessionDestination('U', configured, false)).toBeNull();
    expect(stripeSessionDestination('  ', configured, false)).toBeNull();
    expect(stripeSessionDestination('USA', configured, true)).toBeNull();
  });
  it('accepts any supported country under a catch-all zone', () => {
    expect(stripeSessionDestination('CA', ['US'], true)).toEqual(['CA']);
    expect(stripeSessionDestination('KP', ['US'], true)).toBeNull();
  });
});
