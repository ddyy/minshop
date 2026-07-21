import type { D1Database } from '@cloudflare/workers-types';
import { normalizeTimeZone } from './timeZone';

/**
 * Runtime settings — the small set of values the setup wizard persists to D1 so
 * they can change without a redeploy. Everything else stays build-time config.
 * Reads here OVERLAY env/config defaults; absence means "use the default".
 */

/** Keys we store. Kept narrow on purpose — most config remains build-time. */
export type SettingKey =
  | 'setup_complete' // '1' once the wizard has been finished
  | 'store_name' // overrides config.storeName
  | 'time_zone' // IANA zone for store/admin date display; absent = config/env default
  | 'stripe_webhook_secret' // captured by webhook auto-registration (env wins if set)
  | 'payment_methods_disabled' // CSV of payment methods the admin switched off
  | 'cart_enabled' // '0' = cart/checkout off (browse-only catalog); absent = on
  | 'buy_now_enabled' // '0' = hide "Buy now" (cart-only purchase); absent = on
  | 'search_provider' // 'fts' | 'vector' — overrides config/SEARCH_PROVIDER; absent = default
  | 'admin_password_hash' // PBKDF2 hash of the admin password (set at setup). NOT in StoreSettings — read only by the auth layer, never loaded into locals.
  // Integrations configured in the admin dashboard (non-secret halves; the keys
  // live encrypted in the vault — see features/secrets/store.ts).
  | 'email_enabled' // '0' = order/login email off; absent = on
  | 'email_provider' // 'resend' | 'cloudflare'; absent = resend
  | 'email_from' // sender address; absent = build-time default
  | 'email_from_name' // sender display name; absent = store name
  | 'turnstile_enabled' // '1' = bot challenge on (admin login + customer sign-in); absent = off
  | 'turnstile_site_key' // Turnstile public sitekey
  | 'payment_provider' // 'stripe' | 'lightning' | 'opennode'; absent = stripe
  | 'lightning_backend' // 'phoenixd' | 'lnbits'; absent = phoenixd
  | 'lnbits_url' // LNbits node URL (the invoice/read key is in the vault)
  | 'phoenixd_url' // phoenixd node URL (the password is in the vault)
  | 'opennode_api_url' // OpenNode API base override (testnet); absent = live default
  | `enc:${string}`; // AES-GCM-encrypted secret (see features/secrets/store.ts), e.g. 'enc:stripe_secret_key'. Never loaded as plaintext into locals.

/** The storefront features that can be flipped at runtime (default on). */
export type FeatureKey = 'cart_enabled' | 'buy_now_enabled';

export interface StoreSettings {
  setupComplete: boolean;
  storeName: string | null;
  /** Runtime IANA time zone, or null to use TIME_ZONE / UTC. */
  timeZone: string | null;
  stripeWebhookSecret: string | null;
  /** Methods the admin disabled at runtime. A method is offered iff it's both
   *  configured (keys present) AND not in this list. Empty = nothing disabled. */
  disabledPaymentMethods: string[];
  /** Add-to-cart + checkout available (default true). Off → browse-only catalog. */
  cartEnabled: boolean;
  /** "Buy now" instant-checkout button shown (default true). Requires cartEnabled. */
  buyNowEnabled: boolean;
  /** Search backend chosen at runtime, or null to use the build-time default
   *  (config.search.provider / SEARCH_PROVIDER). */
  searchProvider: 'fts' | 'vector' | null;
  /** Payment-secret names (e.g. 'stripe_secret_key') the admin has stored encrypted
   *  in D1 — i.e. names with a non-empty `enc:` row. Lets the storefront know a key
   *  is configured WITHOUT decrypting it. Env-var fallbacks are checked separately
   *  (see features/secrets/store.ts → hasSecret). */
  configuredSecrets: string[];
  /** Order/login email on (default true; a no-op until a provider key is set). */
  emailEnabled: boolean;
  /** Email backend: 'resend' (free) or 'cloudflare' (paid send_email binding). */
  emailProvider: 'resend' | 'cloudflare';
  /** Sender address / display name, or null to use the build-time defaults. */
  emailFrom: string | null;
  emailFromName: string | null;
  /** Turnstile bot challenge on (admin login + customer sign-in). Default off. */
  turnstileEnabled: boolean;
  /** Turnstile public sitekey, or null. (The secret lives in the vault.) */
  turnstileSiteKey: string | null;
  /** Default payment rail (Settings → Payments). Default 'stripe'. */
  paymentProvider: 'stripe' | 'lightning' | 'opennode';
  /** Self-hosted Lightning node (when provider/rail is lightning). Default 'phoenixd'. */
  lightningBackend: 'phoenixd' | 'lnbits';
  /** Lightning node URLs, or null. (The key/password live in the vault.) */
  lnbitsUrl: string | null;
  phoenixdUrl: string | null;
  /** OpenNode API base override (testnet), or null for the live default. */
  opennodeApiUrl: string | null;
}

/** One setting value, or null if unset. */
export async function getSetting(db: D1Database, key: SettingKey): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/** Upsert a setting (empty/undefined value deletes it → falls back to the default). */
export async function setSetting(
  db: D1Database,
  key: SettingKey,
  value: string | null | undefined,
): Promise<void> {
  if (value == null || value === '') {
    await db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .bind(key, value)
    .run();
}

/** All overlay settings in one read (used by middleware to populate locals). */
export async function getStoreSettings(db: D1Database): Promise<StoreSettings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{
    key: string;
    value: string;
  }>();
  const map = new Map((results ?? []).map((r) => [r.key, r.value]));
  return {
    setupComplete: map.get('setup_complete') === '1',
    storeName: map.get('store_name') ?? null,
    timeZone: normalizeTimeZone(map.get('time_zone')),
    stripeWebhookSecret: map.get('stripe_webhook_secret') ?? null,
    disabledPaymentMethods: (map.get('payment_methods_disabled') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    cartEnabled: map.get('cart_enabled') !== '0',
    buyNowEnabled: map.get('buy_now_enabled') !== '0',
    searchProvider: map.get('search_provider') === 'vector' ? 'vector'
      : map.get('search_provider') === 'fts' ? 'fts'
      : null,
    configuredSecrets: (results ?? [])
      .filter((r) => r.key.startsWith('enc:') && r.value)
      .map((r) => r.key.slice(4)),
    emailEnabled: map.get('email_enabled') !== '0',
    emailProvider: map.get('email_provider') === 'cloudflare' ? 'cloudflare' : 'resend',
    emailFrom: map.get('email_from') ?? null,
    emailFromName: map.get('email_from_name') ?? null,
    turnstileEnabled: map.get('turnstile_enabled') === '1',
    turnstileSiteKey: map.get('turnstile_site_key') ?? null,
    paymentProvider:
      map.get('payment_provider') === 'lightning' ? 'lightning'
      : map.get('payment_provider') === 'opennode' ? 'opennode'
      : 'stripe',
    lightningBackend: map.get('lightning_backend') === 'lnbits' ? 'lnbits' : 'phoenixd',
    lnbitsUrl: map.get('lnbits_url') ?? null,
    phoenixdUrl: map.get('phoenixd_url') ?? null,
    opennodeApiUrl: map.get('opennode_api_url') ?? null,
  };
}

/**
 * Flip a storefront feature on/off. Stored only when OFF ('0') — enabling deletes
 * the row so the default (absent = on) takes over and the table stays tidy.
 */
export async function setFeatureEnabled(
  db: D1Database,
  key: FeatureKey,
  enabled: boolean,
): Promise<void> {
  await setSetting(db, key, enabled ? null : '0');
}

/**
 * Flip one payment method on/off at runtime. Stored as the set of DISABLED
 * methods (so the default — empty — means "offer everything that's configured").
 */
export async function setPaymentMethodDisabled(
  db: D1Database,
  method: string,
  disabled: boolean,
): Promise<void> {
  const current = (await getSetting(db, 'payment_methods_disabled')) ?? '';
  const set = new Set(
    current
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (disabled) set.add(method);
  else set.delete(method);
  // Empty string → setSetting deletes the row → back to the "nothing disabled" default.
  await setSetting(db, 'payment_methods_disabled', [...set].join(','));
}
