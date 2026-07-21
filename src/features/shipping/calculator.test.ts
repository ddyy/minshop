import { describe, it, expect } from 'vitest';
import {
  computeShipping,
  shippingZoneFor,
  allowedCountries,
  type ShippingConfig,
} from './calculator';

const cfg: ShippingConfig = {
  enabled: true,
  zones: [
    {
      countries: ['US'],
      rates: [
        { label: 'Standard', amountCents: 500 },
        { label: 'Express', amountCents: 1500 },
      ],
      freeOverCents: 5000,
    },
    { countries: ['CA', 'MX'], rates: [{ label: 'Standard', amountCents: 1500 }], freeOverCents: null },
    { countries: ['*'], rates: [{ label: 'International', amountCents: 3000 }], freeOverCents: null },
  ],
};

describe('shippingZoneFor', () => {
  it('matches an exact country (case-insensitive)', () => {
    expect(shippingZoneFor('us', cfg.zones)?.rates[0].label).toBe('Standard');
    expect(shippingZoneFor('CA', cfg.zones)?.rates[0].amountCents).toBe(1500);
  });
  it('falls back to the catch-all zone', () => {
    expect(shippingZoneFor('GB', cfg.zones)?.rates[0].label).toBe('International');
  });
  it('returns null when no zone matches and there is no catch-all', () => {
    const noCatch: ShippingConfig = { enabled: true, zones: [{ countries: ['US'], rates: [], freeOverCents: null }] };
    expect(shippingZoneFor('GB', noCatch.zones)).toBeNull();
  });
});

describe('computeShipping', () => {
  it('returns the matching zone rates', () => {
    expect(computeShipping(1000, 'US', cfg).map((o) => o.label)).toEqual(['Standard', 'Express']);
  });
  it('prepends a free option once the subtotal qualifies', () => {
    const opts = computeShipping(5000, 'US', cfg);
    expect(opts[0]).toEqual({ label: 'Free shipping', amountCents: 0 });
    expect(opts).toHaveLength(3);
  });
  it('does not offer free below the threshold', () => {
    expect(computeShipping(4999, 'US', cfg).some((o) => o.amountCents === 0)).toBe(false);
  });
  it('uses the catch-all for unlisted countries', () => {
    expect(computeShipping(1000, 'JP', cfg)).toEqual([{ label: 'International', amountCents: 3000 }]);
  });
  it('returns [] when shipping is disabled', () => {
    expect(computeShipping(1000, 'US', { ...cfg, enabled: false })).toEqual([]);
  });
  it('returns [] for an unshippable destination (no catch-all)', () => {
    const dom: ShippingConfig = { enabled: true, zones: [{ countries: ['US'], rates: [{ label: 'Std', amountCents: 500 }], freeOverCents: null }] };
    expect(computeShipping(1000, 'GB', dom)).toEqual([]);
  });
});

describe('allowedCountries', () => {
  it('collects explicit codes and drops the catch-all', () => {
    expect(allowedCountries(cfg).sort()).toEqual(['CA', 'MX', 'US']);
  });
});
