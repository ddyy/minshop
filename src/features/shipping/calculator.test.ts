import { describe, it, expect } from 'vitest';
import {
  bandFor,
  zonesRequireWeight,
  computeShipping,
  quoteShipping,
  shippingZoneFor,
  allowedCountries,
  hasCatchAllZone,
  normalizeRate,
  FREE_SHIPPING_LABEL,
  type ShippingConfig,
  type WeightBand,
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

const labels = (config: ShippingConfig, subtotal: number, country: string, grams: number | null) =>
  quoteShipping(config, { subtotalCents: subtotal, country, itemWeightGrams: grams }).options.map(
    (o) => o.label,
  );

const BANDS: WeightBand[] = [
  { upToGrams: 500, amountCents: 500 },
  { upToGrams: 1000, amountCents: 800 },
  { upToGrams: 5000, amountCents: 1500 },
  { upToGrams: null, amountCents: 2500 },
];

const weightCfg: ShippingConfig = {
  enabled: true,
  packageWeightGrams: 1,
  zones: [
    {
      name: 'United States',
      countries: ['US'],
      rates: [{ label: 'Standard', pricing: { type: 'weight', bands: BANDS } }],
      freeOverCents: null,
    },
  ],
};

describe('shippingZoneFor', () => {
  it('matches an exact country (case-insensitive)', () => {
    expect(normalizeRate(shippingZoneFor('us', cfg.zones)!.rates[0]!).label).toBe('Standard');
    const ca = normalizeRate(shippingZoneFor('CA', cfg.zones)!.rates[0]!).pricing;
    expect(ca).toEqual({ type: 'flat', amountCents: 1500 });
  });
  it('falls back to the catch-all zone', () => {
    expect(normalizeRate(shippingZoneFor('GB', cfg.zones)!.rates[0]!).label).toBe('International');
  });
  it('returns null when no zone matches and there is no catch-all', () => {
    const noCatch: ShippingConfig = {
      enabled: true,
      zones: [{ countries: ['US'], rates: [], freeOverCents: null }],
    };
    expect(shippingZoneFor('GB', noCatch.zones)).toBeNull();
  });
});

describe('computeShipping (legacy wrapper)', () => {
  it('returns the matching zone rates', () => {
    expect(computeShipping(1000, 'US', cfg).map((o) => o.label)).toEqual(['Standard', 'Express']);
  });
  it('prepends a free option once the subtotal qualifies', () => {
    const opts = computeShipping(5000, 'US', cfg);
    expect(opts[0]).toEqual({ label: FREE_SHIPPING_LABEL, amountCents: 0 });
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
    const dom: ShippingConfig = {
      enabled: true,
      zones: [{ countries: ['US'], rates: [{ label: 'Std', amountCents: 500 }], freeOverCents: null }],
    };
    expect(computeShipping(1000, 'GB', dom)).toEqual([]);
  });
});

describe('legacy rate normalization', () => {
  it('reads a flat-rate-era rate unchanged', () => {
    expect(normalizeRate({ label: 'Standard', amountCents: 500 })).toEqual({
      label: 'Standard',
      pricing: { type: 'flat', amountCents: 500 },
    });
  });
  it('leaves an already-normalized rate alone', () => {
    const rate = { label: 'Standard', pricing: { type: 'flat' as const, amountCents: 500 } };
    expect(normalizeRate(rate)).toBe(rate);
  });
});

describe('weight bands', () => {
  it('selects the band at its exact boundary', () => {
    // 499 g + 1 g packaging === the 500 g band's maximum.
    const quote = quoteShipping(weightCfg, {
      subtotalCents: 1000,
      country: 'US',
      itemWeightGrams: 499,
    });
    expect(quote.shipmentWeightGrams).toBe(500);
    expect(quote.options).toEqual([{ label: 'Standard', amountCents: 500 }]);
  });
  it('moves to the next band one gram above a boundary', () => {
    const quote = quoteShipping(weightCfg, {
      subtotalCents: 1000,
      country: 'US',
      itemWeightGrams: 500,
    });
    expect(quote.shipmentWeightGrams).toBe(501);
    expect(quote.options).toEqual([{ label: 'Standard', amountCents: 800 }]);
  });
  it('uses the unlimited final band for a heavy order', () => {
    expect(bandFor(9_000, BANDS)).toEqual({ upToGrams: null, amountCents: 2500 });
  });
  it('omits a service heavier than its finite final band', () => {
    const capped: ShippingConfig = {
      ...weightCfg,
      zones: [
        {
          ...weightCfg.zones[0]!,
          rates: [
            {
              label: 'Standard',
              pricing: { type: 'weight', bands: [{ upToGrams: 1000, amountCents: 500 }] },
            },
          ],
        },
      ],
    };
    const quote = quoteShipping(capped, {
      subtotalCents: 1000,
      country: 'US',
      itemWeightGrams: 2000,
    });
    expect(quote.options).toEqual([]);
    expect(quote.omitted).toEqual([{ label: 'Standard', reason: 'overweight' }]);
  });
  it('adds the package allowance exactly once', () => {
    const twoRates: ShippingConfig = {
      ...weightCfg,
      packageWeightGrams: 100,
      zones: [
        {
          ...weightCfg.zones[0]!,
          rates: [
            { label: 'A', pricing: { type: 'weight', bands: BANDS } },
            { label: 'B', pricing: { type: 'weight', bands: BANDS } },
          ],
        },
      ],
    };
    const quote = quoteShipping(twoRates, {
      subtotalCents: 0,
      country: 'US',
      itemWeightGrams: 400,
    });
    expect(quote.shipmentWeightGrams).toBe(500);
  });
  it('treats zero weight and zero-priced bands as valid', () => {
    const free: ShippingConfig = {
      enabled: true,
      zones: [
        {
          countries: ['US'],
          rates: [
            { label: 'Letter', pricing: { type: 'weight', bands: [{ upToGrams: 50, amountCents: 0 }] } },
          ],
          freeOverCents: null,
        },
      ],
    };
    const quote = quoteShipping(free, { subtotalCents: 0, country: 'US', itemWeightGrams: 0 });
    expect(quote.options).toEqual([{ label: 'Letter', amountCents: 0 }]);
  });
});

describe('local pickup', () => {
  const pickupZone: ShippingConfig = {
    enabled: true,
    zones: [
      {
        countries: ['US'],
        rates: [
          { label: 'By weight', pricing: { type: 'weight', bands: [{ upToGrams: 1000, amountCents: 500 }] } },
          { label: 'Local pickup', pricing: { type: 'pickup', amountCents: 0 } },
        ],
        freeOverCents: null,
      },
    ],
  };
  it('survives an unknown weight — the shopper carries it', () => {
    const quote = quoteShipping(pickupZone, { subtotalCents: 0, country: 'US', itemWeightGrams: null });
    expect(quote.options).toEqual([{ label: 'Local pickup', amountCents: 0, pickup: true }]);
    expect(quote.omitted).toEqual([{ label: 'By weight', reason: 'missing_weight' }]);
  });
  it('survives an order heavier than every carrier band', () => {
    const quote = quoteShipping(pickupZone, { subtotalCents: 0, country: 'US', itemWeightGrams: 99_999 });
    expect(quote.options).toEqual([{ label: 'Local pickup', amountCents: 0, pickup: true }]);
  });
  it('may charge a packing fee', () => {
    const feeZone: ShippingConfig = {
      enabled: true,
      zones: [
        { countries: ['US'], rates: [{ label: 'Pickup', pricing: { type: 'pickup', amountCents: 200 } }], freeOverCents: null },
      ],
    };
    const quote = quoteShipping(feeZone, { subtotalCents: 0, country: 'US', itemWeightGrams: 100 });
    expect(quote.options).toEqual([{ label: 'Pickup', amountCents: 200, pickup: true }]);
  });
  it('never lets a free-over threshold conjure a delivery in a pickup-only zone', () => {
    // "Free shipping" is a delivery promise; a merchant who configured only
    // pickup has no way to fulfil it.
    const pickupOnly: ShippingConfig = {
      enabled: true,
      zones: [
        {
          countries: ['US'],
          rates: [{ label: 'Local pickup', pricing: { type: 'pickup', amountCents: 0 } }],
          freeOverCents: 1000,
        },
      ],
    };
    const quote = quoteShipping(pickupOnly, { subtotalCents: 5000, country: 'US', itemWeightGrams: 100 });
    expect(quote.options).toEqual([{ label: 'Local pickup', amountCents: 0, pickup: true }]);
  });
  it('does not offer free delivery when the only delivery rate was omitted', () => {
    const quote = quoteShipping(
      { ...pickupZone, zones: [{ ...pickupZone.zones[0]!, freeOverCents: 1000 }] },
      { subtotalCents: 5000, country: 'US', itemWeightGrams: null },
    );
    // Pickup survives; the weight rate is omitted; free DELIVERY must not appear.
    expect(quote.options).toEqual([{ label: 'Local pickup', amountCents: 0, pickup: true }]);
    expect(quote.omitted).toEqual([{ label: 'By weight', reason: 'missing_weight' }]);
  });
  it('still offers free shipping when a real delivery rate resolved beside pickup', () => {
    const mixed: ShippingConfig = {
      enabled: true,
      zones: [
        {
          countries: ['US'],
          rates: [
            { label: 'Standard', pricing: { type: 'flat', amountCents: 500 } },
            { label: 'Local pickup', pricing: { type: 'pickup', amountCents: 0 } },
          ],
          freeOverCents: 1000,
        },
      ],
    };
    const labels = quoteShipping(mixed, { subtotalCents: 5000, country: 'US', itemWeightGrams: null }).options.map((o) => o.label);
    expect(labels).toEqual([FREE_SHIPPING_LABEL, 'Standard', 'Local pickup']);
  });
  it('counts as a non-weight fallback, so weights stay optional', () => {
    expect(zonesRequireWeight(pickupZone)).toBe(false);
  });
});

describe('unknown weight', () => {
  it('omits only the weight-priced services', () => {
    const mixed: ShippingConfig = {
      enabled: true,
      zones: [
        {
          countries: ['US'],
          rates: [
            { label: 'Flat', amountCents: 700 },
            { label: 'By weight', pricing: { type: 'weight', bands: BANDS } },
          ],
          freeOverCents: null,
        },
      ],
    };
    const quote = quoteShipping(mixed, {
      subtotalCents: 0,
      country: 'US',
      itemWeightGrams: null,
      missingWeight: [{ productId: 12, variantId: null, name: 'Cast iron pan' }],
    });
    expect(quote.options).toEqual([{ label: 'Flat', amountCents: 700 }]);
    expect(quote.omitted).toEqual([{ label: 'By weight', reason: 'missing_weight' }]);
    expect(quote.missingWeight[0]!.name).toBe('Cast iron pan');
    expect(quote.shipmentWeightGrams).toBeNull();
  });
  it('blocks when every service is weight-priced', () => {
    const quote = quoteShipping(weightCfg, {
      subtotalCents: 0,
      country: 'US',
      itemWeightGrams: null,
    });
    expect(quote.options).toEqual([]);
    expect(quote.omitted).toEqual([{ label: 'Standard', reason: 'missing_weight' }]);
  });
  it('reports an unsupported destination with an empty omitted set', () => {
    const quote = quoteShipping(weightCfg, {
      subtotalCents: 0,
      country: 'JP',
      itemWeightGrams: 100,
    });
    expect(quote.options).toEqual([]);
    expect(quote.omitted).toEqual([]);
  });
});

describe('free shipping eligibility', () => {
  const withFree = (rates: ShippingConfig['zones'][number]['rates']): ShippingConfig => ({
    enabled: true,
    packageWeightGrams: 0,
    zones: [{ countries: ['US'], rates, freeOverCents: 5000 }],
  });

  it('cannot bypass an overweight weight-priced service', () => {
    const cappedRate = {
      label: 'Standard',
      pricing: { type: 'weight' as const, bands: [{ upToGrams: 1000, amountCents: 500 }] },
    };
    expect(labels(withFree([cappedRate]), 9999, 'US', 5000)).toEqual([]);
  });
  it('cannot bypass an unknown weight', () => {
    const rate = { label: 'Standard', pricing: { type: 'weight' as const, bands: BANDS } };
    expect(labels(withFree([rate]), 9999, 'US', null)).toEqual([]);
  });
  it('is offered when a weight service is still eligible', () => {
    const rate = { label: 'Standard', pricing: { type: 'weight' as const, bands: BANDS } };
    expect(labels(withFree([rate]), 9999, 'US', 100)).toEqual([FREE_SHIPPING_LABEL, 'Standard']);
  });
  it('still synthesizes for a legacy threshold-only flat zone with no rates', () => {
    expect(labels(withFree([]), 9999, 'US', null)).toEqual([FREE_SHIPPING_LABEL]);
  });
});

describe('band coverage (property)', () => {
  // Hand-written boundary cases miss gaps and overlaps; walking the whole range
  // proves every gram selects exactly one band or none.
  const arrays: WeightBand[][] = [
    BANDS,
    [{ upToGrams: 1, amountCents: 100 }, { upToGrams: null, amountCents: 200 }],
    [{ upToGrams: 250, amountCents: 100 }, { upToGrams: 1000, amountCents: 200 }],
  ];
  it('selects exactly one band or none for every gram', () => {
    for (const bands of arrays) {
      const finite = bands.filter((b) => b.upToGrams != null);
      const last = bands[bands.length - 1]!;
      const ceiling = (last.upToGrams ?? finite[finite.length - 1]?.upToGrams ?? 0) + 1;
      for (let grams = 0; grams <= ceiling; grams += 1) {
        const matches = bands.filter(
          (b, i) =>
            (b.upToGrams == null || grams <= b.upToGrams) &&
            bands.slice(0, i).every((prev) => prev.upToGrams != null && grams > prev.upToGrams),
        );
        expect(matches.length).toBeLessThanOrEqual(1);
        expect(bandFor(grams, bands)).toEqual(matches[0] ?? null);
      }
    }
  });
});

describe('allowedCountries', () => {
  it('collects explicit codes and drops the catch-all', () => {
    expect(allowedCountries(cfg).sort()).toEqual(['CA', 'MX', 'US']);
  });
  it('reports a catch-all zone so providers can expand it', () => {
    expect(hasCatchAllZone(cfg)).toBe(true);
    expect(hasCatchAllZone(weightCfg)).toBe(false);
  });
});
