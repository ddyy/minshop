import { readFileSync } from 'node:fs';
import { COUNTRY_CODES } from '../src/features/shipping/countries.ts';
import { stripeAllowedCountries } from '../src/features/payments/stripeCountries.ts';

// The catch-all expansion sends Stripe every country we know MINUS a denylist. If
// that denylist drifts from the installed SDK's AllowedCountry union, a "Rest of
// world" store either loses valid destinations or fails session creation outright
// — neither is visible until a real checkout. So diff the two here.
const sdkSource = readFileSync(
  new URL('../node_modules/stripe/esm/resources/Checkout/Sessions.d.ts', import.meta.url),
  'utf8',
);
const start = sdkSource.indexOf('type AllowedCountry =');
const union = sdkSource.slice(start, sdkSource.indexOf(';', start));
const accepted = new Set([...union.matchAll(/'([A-Z]{2})'/g)].map((m) => m[1]));

const expanded = stripeAllowedCountries([], true);
const rejected = expanded.filter((c) => !accepted.has(c));
const missing = COUNTRY_CODES.filter((c) => accepted.has(c) && !expanded.includes(c));

let failures = 0;
if (rejected.length > 0) {
  failures++;
  console.error(`  ✗ sends codes Stripe rejects: ${rejected.join(' ')}`);
}
if (missing.length > 0) {
  failures++;
  console.error(`  ✗ omits codes Stripe accepts: ${missing.join(' ')}`);
}
if (failures === 0) {
  console.log(`  ✓ catch-all expansion matches the pinned SDK (${expanded.length} countries)`);
  console.log('stripe country check passed');
} else {
  console.error('\nUpdate STRIPE_UNSUPPORTED in src/features/payments/stripe.ts');
  process.exit(1);
}
