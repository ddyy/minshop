/**
 * The Stripe destination pre-selector, shared by /cart and /express so the two
 * cannot drift: Stripe's hosted page takes a static rate list before it knows the
 * address, so the shopper picks the country first and the session is priced for
 * that zone. The in-app rails (Lightning/OpenNode/Demo) collect the address on
 * /checkout and never need this.
 *
 * The list is Stripe-filtered because it exists FOR Stripe — offering a country
 * Stripe cannot collect an address for would price a session that then fails.
 * And it must be submitted even when only ONE country remains: with the field
 * absent the server falls back to the raw first zone, which may be exactly the
 * unsupported one the filter removed.
 */

import type { StoreSettings } from '../settings/db';
import { enabledMethods } from '../payments';
import { stripeAllowedCountries } from '../payments/stripeCountries.ts';
import { allowedCountries, hasCatchAllZone, type ShippingConfig } from './calculator';
import { COUNTRY_CODES, countryName } from './countries';

export interface StripeDestination {
  /** Stripe-supported destinations, in zone order. Empty = no selector at all. */
  countries: string[];
  /** Render the visible <select> (more than one choice). */
  showSelect: boolean;
  /** Render a hidden country field (exactly one choice — it must still submit). */
  hiddenOnly: boolean;
  /** Human label for a code; verbose names only for catch-all stores. */
  label: (code: string) => string;
}

export function stripeDestination(
  settings: StoreSettings | null | undefined,
  effectiveShipping: ShippingConfig,
  shippingRequired: boolean,
): StripeDestination {
  // `enabledMethods`, not `isMethodAvailable`: a merchant who DISABLED their
  // configured Stripe rail gets no card button, so a card-only selector would be
  // furniture for a flow that cannot happen.
  const stripeOffered = settings ? enabledMethods(settings).includes('stripe') : false;
  const anywhere = hasCatchAllZone(effectiveShipping);
  const countries =
    effectiveShipping.enabled && shippingRequired && stripeOffered
      ? stripeAllowedCountries(
          anywhere ? [...COUNTRY_CODES] : allowedCountries(effectiveShipping),
          false,
        )
      : [];
  return {
    countries,
    showSelect: countries.length > 1,
    hiddenOnly: countries.length === 1,
    label: (code) => (anywhere ? `${countryName(code)} (${code})` : code),
  };
}
