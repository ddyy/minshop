/**
 * Provider-agnostic shipping. Stripe Checkout *used* to own shipping (it collected
 * the address and showed rate options on its hosted page); to support non-Stripe
 * rails (Lightning), the rate logic lives here instead and feeds the order total
 * BEFORE a payment provider is chosen — so every rail charges the same number.
 *
 * Model: destination ZONES of rates. A zone matches by country (ISO alpha-2), with
 * '*' as a catch-all. A rate is priced either flat or by total shipment weight
 * (ordered brackets). Pure + dependency-free (no `cloudflare:workers`), so it's
 * unit-testable. Swap `createConfigRatesCalculator` for a carrier-rates adapter
 * (EasyPost/Shippo) later without touching callers.
 */

/** The synthesized free-shipping option's label. Shared with Admin validation so a
 *  configured rate can neither collide with it nor drift away from it. */
export const FREE_SHIPPING_LABEL = 'Free shipping';

export interface ShippingOption {
  label: string;
  amountCents: number;
  /** Collected in person — no carrier, no delivery. Fulfillment needs this as
   *  DATA (orders record it as delivery_method); the label text is merchant
   *  prose and must never be parsed for meaning. */
  pickup?: boolean;
}

export interface FlatRatePricing {
  type: 'flat';
  amountCents: number;
}

/**
 * Ordered brackets. The shipment weight selects ONE band — bands are not
 * accumulated. The first band covers 0 through its maximum; each later band starts
 * one gram above the previous one. `upToGrams: null` means unlimited and is legal
 * only on the last band; a finite last band makes the service unavailable above it.
 */
export interface WeightBand {
  upToGrams: number | null;
  amountCents: number;
}

export interface WeightRatePricing {
  type: 'weight';
  bands: WeightBand[];
}

/**
 * Collected in person, so weight can never disqualify it and no carrier is
 * involved. Usually free; a flat fee covers stores that charge for packing.
 * The address step still runs — it selects the zone and gives the merchant a
 * contact — but nothing will be posted anywhere.
 */
export interface PickupRatePricing {
  type: 'pickup';
  amountCents: number;
}

export type RatePricing = FlatRatePricing | WeightRatePricing | PickupRatePricing;

export interface ShippingRate {
  label: string;
  pricing: RatePricing;
}

/** What a zone may hold. The legacy `{ label, amountCents }` shape predates weight
 *  pricing and is still what installed `store.config.ts` files contain, so it stays
 *  accepted at the boundary and is normalized to flat pricing on read. */
export type ConfiguredRate = ShippingOption | ShippingRate;

export interface ShippingZone {
  /** Optional display name. Admin requires one; build-time config never had them. */
  name?: string;
  /** ISO 3166-1 alpha-2 codes this zone serves, or ['*'] as a catch-all. */
  countries: string[];
  rates: ConfiguredRate[];
  /** Add a $0 "Free shipping" option once the subtotal reaches this (null = never). */
  freeOverCents: number | null;
}

export interface ShippingConfig {
  enabled: boolean;
  /** One box/mailer/padding allowance, added once per shipment. Absent = 0. */
  packageWeightGrams?: number;
  /** Evaluated top-to-bottom; first zone matching the country wins ('*' last). */
  zones: ShippingZone[];
}

/** A catalog record whose shipping weight is unknown, named so checkout can say
 *  which product to fix rather than failing anonymously. */
export interface MissingWeightRecord {
  productId: number;
  variantId: number | null;
  name: string;
}

/** Why a configured service is not being offered. Diagnostics, not shopper copy. */
export interface OmittedRate {
  label: string;
  reason: 'missing_weight' | 'overweight';
}

/**
 * One diagnostic result shared by browser checkout, the in-app address flow, and
 * JSON checkout. There is deliberately no `ok` discriminant: a quote can succeed
 * *and* have dropped services, which a union cannot express. For a required
 * shipment under an enabled configuration, `options.length === 0` blocks checkout;
 * an empty `omitted` then means the destination is unsupported rather than that
 * weight failed.
 */
export interface ShippingQuote {
  /** Package allowance + item weight, or null when a required weight is unknown. */
  shipmentWeightGrams: number | null;
  options: ShippingOption[];
  omitted: OmittedRate[];
  missingWeight: MissingWeightRecord[];
}

export interface ShippingQuoteInput {
  subtotalCents: number;
  country: string;
  /** Resolved item weight (excluding the package allowance), or null if unknown. */
  itemWeightGrams: number | null;
  /** Records behind an unknown weight, for the "fix these products" message. */
  missingWeight?: MissingWeightRecord[];
}

/** Normalize either accepted rate shape to the internal discriminated one. */
export function normalizeRate(rate: ConfiguredRate): ShippingRate {
  if ('pricing' in rate) return rate;
  return { label: rate.label, pricing: { type: 'flat', amountCents: rate.amountCents } };
}

/** First zone whose `countries` includes `country`; falls back to a '*' zone. */
export function shippingZoneFor(country: string, zones: ShippingZone[]): ShippingZone | null {
  const cc = country.toUpperCase();
  return (
    zones.find((z) => z.countries.some((c) => c.toUpperCase() === cc)) ??
    zones.find((z) => z.countries.includes('*')) ??
    null
  );
}

/** The band a shipment falls in, or null when it is heavier than the last one. */
export function bandFor(shipmentWeightGrams: number, bands: WeightBand[]): WeightBand | null {
  for (const band of bands) {
    if (band.upToGrams == null || shipmentWeightGrams <= band.upToGrams) return band;
  }
  return null;
}

/**
 * Price a destination. Callers must resolve `shippingRequired` and the effective
 * `enabled` flag BEFORE calling: an all-digital cart or a shipping-disabled store
 * bypasses shipping entirely, which keeps "no options" unambiguously blocking here.
 */
export function quoteShipping(cfg: ShippingConfig, input: ShippingQuoteInput): ShippingQuote {
  const missingWeight = input.missingWeight ?? [];
  const zone = shippingZoneFor(input.country, cfg.zones);
  if (!zone) return { shipmentWeightGrams: null, options: [], omitted: [], missingWeight };

  const packageWeightGrams = cfg.packageWeightGrams ?? 0;
  const shipmentWeightGrams =
    input.itemWeightGrams == null ? null : packageWeightGrams + input.itemWeightGrams;

  const rates = zone.rates.map(normalizeRate);
  const options: ShippingOption[] = [];
  const omitted: OmittedRate[] = [];

  // Whether some DELIVERY service resolved — pickup never counts: it is not a
  // way to send the parcel, so it must not unlock free *delivery*.
  let deliveryResolved = false;
  for (const rate of rates) {
    if (rate.pricing.type === 'pickup') {
      // Weight can never disqualify pickup: the shopper carries it.
      options.push({ label: rate.label, amountCents: rate.pricing.amountCents, pickup: true });
      continue;
    }
    if (rate.pricing.type === 'flat') {
      // Flat rates do not care about weight, so an unknown weight must not hide them.
      options.push({ label: rate.label, amountCents: rate.pricing.amountCents });
      deliveryResolved = true;
      continue;
    }
    if (shipmentWeightGrams == null) {
      omitted.push({ label: rate.label, reason: 'missing_weight' });
      continue;
    }
    const band = bandFor(shipmentWeightGrams, rate.pricing.bands);
    if (!band) {
      omitted.push({ label: rate.label, reason: 'overweight' });
      continue;
    }
    options.push({ label: rate.label, amountCents: band.amountCents });
    deliveryResolved = true;
  }

  // "Free shipping" is a DELIVERY promise, so it is synthesized only when a real
  // delivery service resolved: a threshold must not bypass a carrier maximum or
  // an unknown weight, and a pickup-only zone must not conjure a delivery the
  // merchant never configured. The one legacy exception stands: a threshold-only
  // zone with NO configured rates has always synthesized it.
  const qualifies = zone.freeOverCents != null && input.subtotalCents >= zone.freeOverCents;
  if (qualifies && (rates.length === 0 || deliveryResolved)) {
    options.unshift({ label: FREE_SHIPPING_LABEL, amountCents: 0 });
  }

  return { shipmentWeightGrams, options, omitted, missingWeight };
}

/**
 * Shipping options for a destination. Empty array = we don't ship there (or
 * shipping is disabled) — callers treat that as "no shipping offered". Retained as
 * the flat-rate-era signature while callers migrate to `quoteShipping`.
 */
export function computeShipping(
  subtotalCents: number,
  country: string,
  cfg: ShippingConfig,
): ShippingOption[] {
  if (!cfg.enabled) return [];
  return quoteShipping(cfg, { subtotalCents, country, itemWeightGrams: null }).options;
}

/** Explicit destination countries, for Stripe's `allowed_countries` (drops '*'). */
export function allowedCountries(cfg: ShippingConfig): string[] {
  const set = new Set<string>();
  for (const z of cfg.zones) {
    for (const c of z.countries) if (c !== '*') set.add(c.toUpperCase());
  }
  return [...set];
}

/**
 * True when some enabled zone can only be priced by weight — i.e. when a product
 * without a weight becomes unsellable to that destination. Admin uses this to make
 * the broken state unreachable (required field on the product form, rejected save
 * on the shipping form) instead of letting it surface as lost checkouts.
 */
export function zonesRequireWeight(cfg: ShippingConfig): boolean {
  if (!cfg.enabled) return false;
  return cfg.zones.some((zone) => {
    const rates = zone.rates.map(normalizeRate);
    return rates.length > 0 && rates.every((rate) => rate.pricing.type === 'weight');
  });
}

/** Whether any zone accepts the rest of the world. Providers expand this into their
 *  own supported-country list; the core calculator stays provider-neutral. */
export function hasCatchAllZone(cfg: ShippingConfig): boolean {
  return cfg.zones.some((z) => z.countries.includes('*'));
}

/** The shipping port. ConfigRates is the default adapter; carrier rates can be another. */
export interface ShippingCalculator {
  optionsFor(input: { subtotalCents: number; country: string }): ShippingOption[];
  quoteFor(input: ShippingQuoteInput): ShippingQuote;
  /** Countries this store ships to (explicit codes; for Stripe address collection). */
  allowedCountries(): string[];
  hasCatchAll(): boolean;
}

export function createConfigRatesCalculator(cfg: ShippingConfig): ShippingCalculator {
  return {
    optionsFor: ({ subtotalCents, country }) => computeShipping(subtotalCents, country, cfg),
    quoteFor: (input) => quoteShipping(cfg, input),
    allowedCountries: () => allowedCountries(cfg),
    hasCatchAll: () => hasCatchAllZone(cfg),
  };
}
