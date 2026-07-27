/**
 * Which countries Stripe Checkout will collect an address for.
 *
 * A "rest of world" zone carries no explicit codes, and an EMPTY
 * `allowed_countries` is an API error rather than "anywhere" — so the catch-all is
 * expanded here, at the provider boundary, instead of leaking Stripe's limits into
 * the zone calculator.
 *
 * Split out of `stripe.ts` so it stays pure: no SDK client, no Worker env, so both
 * unit tests and scripts/check-stripe-countries.mjs can load it directly.
 */

import { COUNTRY_CODES, isCountryCode } from '../shipping/countries.ts';

/**
 * Exactly the ISO alpha-2 codes absent from the pinned SDK's
 * `Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry`
 * union. Derived, not judged: a hand-guessed list both dropped valid destinations
 * and included codes Stripe rejects, and the second kind fails session creation
 * outright. `scripts/check-stripe-countries.mjs` fails the build if this drifts
 * from the installed SDK.
 */
export const STRIPE_UNSUPPORTED: ReadonlySet<string> = new Set([
  'AS', 'CC', 'CU', 'CX', 'FM', 'HM', 'IR', 'KP',
  'MH', 'MP', 'NF', 'PW', 'SY', 'UM', 'VI',
]);

export function stripeAllowedCountries(explicit: string[], hasCatchAll: boolean): string[] {
  const codes = hasCatchAll ? COUNTRY_CODES : explicit;
  return codes.map((c) => c.toUpperCase()).filter((c) => !STRIPE_UNSUPPORTED.has(c));
}

/**
 * The countries a Stripe SESSION may collect an address for: exactly the one the
 * rates were quoted against, or null when that country cannot be used.
 *
 * Rates are priced BEFORE Stripe collects the address, so any wider list lets the
 * shopper keep a cheap zone's rate while entering an address in an expensive one
 * — pick "US", pay US shipping, ship to Canada. Narrowing to the quoted country
 * closes that, and rejecting unsupported/unconfigured countries here (before any
 * inventory is reserved) closes the crafted-POST variant where a bogus country
 * rode along with an otherwise nonempty global list.
 */
export function stripeSessionDestination(
  country: string,
  configured: string[],
  hasCatchAll: boolean,
): string[] | null {
  const cc = country.toUpperCase();
  if (!isCountryCode(cc)) return null;
  if (STRIPE_UNSUPPORTED.has(cc)) return null;
  if (!hasCatchAll && !configured.some((c) => c.toUpperCase() === cc)) return null;
  return [cc];
}
