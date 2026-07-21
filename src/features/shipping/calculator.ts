/**
 * Provider-agnostic shipping. Stripe Checkout *used* to own shipping (it collected
 * the address and showed rate options on its hosted page); to support non-Stripe
 * rails (Lightning), the rate logic lives here instead and feeds the order total
 * BEFORE a payment provider is chosen — so every rail charges the same number.
 *
 * Model: destination ZONES of flat rates. A zone matches by country (ISO alpha-2),
 * with '*' as a catch-all. Pure + dependency-free (no `cloudflare:workers`), so
 * it's unit-testable. Swap `createConfigRatesCalculator` for a carrier-rates
 * adapter (EasyPost/Shippo) later without touching callers.
 */

export interface ShippingOption {
  label: string;
  amountCents: number;
}

export interface ShippingZone {
  /** ISO 3166-1 alpha-2 codes this zone serves, or ['*'] as a catch-all. */
  countries: string[];
  rates: ShippingOption[];
  /** Add a $0 "Free shipping" option once the subtotal reaches this (null = never). */
  freeOverCents: number | null;
}

export interface ShippingConfig {
  enabled: boolean;
  /** Evaluated top-to-bottom; first zone matching the country wins ('*' last). */
  zones: ShippingZone[];
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

/**
 * Shipping options for a destination. Empty array = we don't ship there (or
 * shipping is disabled) — callers treat that as "no shipping offered". Prepends a
 * free option when the subtotal qualifies.
 */
export function computeShipping(
  subtotalCents: number,
  country: string,
  cfg: ShippingConfig,
): ShippingOption[] {
  if (!cfg.enabled) return [];
  const zone = shippingZoneFor(country, cfg.zones);
  if (!zone) return [];
  const options = [...zone.rates];
  if (zone.freeOverCents != null && subtotalCents >= zone.freeOverCents) {
    options.unshift({ label: 'Free shipping', amountCents: 0 });
  }
  return options;
}

/** Explicit destination countries, for Stripe's `allowed_countries` (drops '*'). */
export function allowedCountries(cfg: ShippingConfig): string[] {
  const set = new Set<string>();
  for (const z of cfg.zones) {
    for (const c of z.countries) if (c !== '*') set.add(c.toUpperCase());
  }
  return [...set];
}

/** The shipping port. ConfigRates is the default adapter; carrier rates can be another. */
export interface ShippingCalculator {
  optionsFor(input: { subtotalCents: number; country: string }): ShippingOption[];
  /** Countries this store ships to (explicit codes; for Stripe address collection). */
  allowedCountries(): string[];
}

export function createConfigRatesCalculator(cfg: ShippingConfig): ShippingCalculator {
  return {
    optionsFor: ({ subtotalCents, country }) => computeShipping(subtotalCents, country, cfg),
    allowedCountries: () => allowedCountries(cfg),
  };
}
