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

import { COUNTRY_CODES } from '../shipping/countries.ts';

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
