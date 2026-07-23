import { env } from 'cloudflare:workers';
import type { PaymentProvider } from './provider';
import type { StoreSettings } from '../settings/db';
import { getStoreSettings } from '../settings/db';
import { createStripeProvider } from './stripe';
import { createLightningProvider } from './lightning-provider';
import { getLightningBackend } from './lightning';
import { createOpenNodeProvider } from './opennode';
import { createDemoProvider } from './demo';
import { getSecret, vaultReady } from '../secrets/store';

export type { PaymentProvider } from './provider';
export {
  STRIPE_CHECKOUT_TTL_SECONDS,
  OPENNODE_CHECKOUT_TTL_SECONDS,
  RESERVATION_EXPIRY_GRACE_SECONDS,
} from './provider';

// 'demo' is a first-class method — a simulated checkout that's ALWAYS offered
// (records a real, demo-tagged order). The real rails work only when configured.
export type PaymentMethod = 'stripe' | 'lightning' | 'opennode' | 'demo';
const ALL_METHODS: PaymentMethod[] = ['stripe', 'lightning', 'opennode'];
// The buttons always presented at checkout. Each real rail works if configured,
// else its button leads to setup instructions; demo always works.
const OFFERED: PaymentMethod[] = ['stripe', 'lightning', 'demo'];

export function isPaymentMethod(value: string): value is PaymentMethod {
  return value === 'stripe' || value === 'lightning' || value === 'opennode' || value === 'demo';
}

/**
 * Whether a method can actually process a payment right now. Real rails need their
 * keys (and Lightning its node URL) — all configured in the admin dashboard and
 * read from the runtime settings overlay (`Astro.locals.settings` /
 * getStoreSettings). Sync (no decryption) so it's cheap per render — the actual key
 * is only decrypted in getPaymentProvider. Demo always works.
 */
export function isMethodAvailable(
  method: PaymentMethod,
  settings: StoreSettings,
  vault = vaultReady(),
): boolean {
  const has = (name: string) => vault && settings.configuredSecrets.includes(name);
  switch (method) {
    case 'stripe':
      return has('stripe_secret_key') && has('stripe_webhook_secret');
    case 'opennode':
      return has('opennode_api_key');
    case 'lightning':
      return settings.lightningBackend === 'lnbits'
        ? !!settings.lnbitsUrl && has('lnbits_api_key')
        : !!settings.phoenixdUrl && has('phoenixd_password');
    case 'demo':
      return true; // demo is always usable
  }
}

/** True when at least one REAL payment rail is configured (demo doesn't count). */
export function hasRealMethod(settings: StoreSettings, vault = vaultReady()): boolean {
  return ALL_METHODS.some((m) => isMethodAvailable(m, settings, vault));
}

/** No real rail configured: only the demo method can take a payment. */
export function paymentsInDemoMode(settings: StoreSettings, vault = vaultReady()): boolean {
  return !hasRealMethod(settings, vault);
}

/** The store's default rail (Settings → Payments; default 'stripe'). */
export function defaultMethod(settings: StoreSettings): PaymentMethod {
  return settings.paymentProvider;
}

/**
 * Methods a buyer/agent can actually pay with right now — the configured real
 * rails plus demo, minus any the admin has disabled at runtime. Used by the agent
 * checkout + discovery, so callers are never handed a method that isn't wired up
 * (or has been switched off). May be EMPTY (admin disabled everything) — callers
 * hide checkout rather than falling back to a method nobody enabled.
 */
export function enabledMethods(
  settings: StoreSettings,
  vault = vaultReady(),
): PaymentMethod[] {
  const off = new Set(settings.disabledPaymentMethods);
  const def = defaultMethod(settings);
  const orderedReal =
    def === 'demo' ? ALL_METHODS : [def, ...ALL_METHODS.filter((m) => m !== def)];
  const real = orderedReal
    .filter((m): m is Exclude<PaymentMethod, 'demo'> => m !== 'demo')
    .filter((m) => isMethodAvailable(m, settings, vault))
    .filter((m) => !off.has(m));
  if (off.has('demo')) return real;
  return def === 'demo' ? ['demo', ...real] : [...real, 'demo'];
}

/**
 * Methods the checkout UI shows as buttons — Card, Lightning, Demo (plus any
 * other configured rail, e.g. OpenNode), minus any the admin disabled. Unlike
 * enabledMethods, this keeps UNconfigured-but-not-disabled real rails so they can
 * render a "set this up" link. May be EMPTY when the admin disables everything —
 * the cart/product pages then hide checkout entirely.
 */
export function offeredMethods(
  settings: StoreSettings,
  vault = vaultReady(),
): PaymentMethod[] {
  const off = new Set(settings.disabledPaymentMethods);
  const extra = ALL_METHODS.filter(
    (m) => !OFFERED.includes(m) && isMethodAvailable(m, settings, vault),
  );
  return (['stripe', 'lightning', ...extra, 'demo'] as PaymentMethod[]).filter((m) => !off.has(m));
}

/**
 * Build a concrete payment provider. `method` selects the rail; omitted → the
 * store default. Keys/URLs are resolved from the admin config (D1 settings + the
 * encrypted vault). Real methods fail closed when their secrets cannot be
 * decrypted; only an explicit `demo` selection constructs the simulator. The
 * checkout + webhook + refund routes are the only callers.
 */
export async function getPaymentProvider(method?: PaymentMethod): Promise<PaymentProvider> {
  const settings = await getStoreSettings(env.DB);
  const m = method ?? settings.paymentProvider;
  if (m === 'demo') return createDemoProvider(env.DB);
  switch (m) {
    case 'lightning':
      // Self-hosted Lightning (phoenixd / LNbits) behind a self-rendered pay page.
      return createLightningProvider(env.DB, await getLightningBackend());
    case 'opennode': {
      const key = await getSecret(env.DB, 'opennode_api_key');
      if (!key) throw new Error('OpenNode is not configured.');
      return createOpenNodeProvider(env.DB, key, settings.opennodeApiUrl ?? undefined);
    }
    case 'stripe':
    default: {
      const secretKey = await getSecret(env.DB, 'stripe_secret_key');
      const webhookSecret = await getSecret(env.DB, 'stripe_webhook_secret');
      if (!secretKey || !webhookSecret) throw new Error('Stripe is not fully configured.');
      return createStripeProvider(secretKey, webhookSecret);
    }
  }
}
