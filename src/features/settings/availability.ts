import type { StoreSettings } from './db';

export interface RuntimeCapabilities {
  vault: boolean;
  authSecret: boolean;
  images: boolean;
  emailBinding: boolean;
  ai: boolean;
  vectorize: boolean;
}

export interface SettingAvailability {
  available: boolean;
  reason?: string;
}

const hasSecret = (settings: StoreSettings, caps: RuntimeCapabilities, name: string): boolean =>
  caps.vault && settings.configuredSecrets.includes(name);

export function stripeConfigured(
  settings: StoreSettings,
  caps: RuntimeCapabilities,
): boolean {
  return (
    hasSecret(settings, caps, 'stripe_secret_key') &&
    hasSecret(settings, caps, 'stripe_webhook_secret')
  );
}

export function emailConfigured(
  settings: StoreSettings,
  caps: RuntimeCapabilities,
): boolean {
  if (!settings.emailEnabled) return false;
  return settings.emailProvider === 'cloudflare'
    ? caps.emailBinding
    : hasSecret(settings, caps, 'resend_api_key');
}

export function featureAvailability(
  key: string,
  settings: StoreSettings,
  caps: RuntimeCapabilities,
): SettingAvailability {
  if (key === 'discounts_enabled' || key === 'tax_enabled') {
    return stripeConfigured(settings, caps)
      ? { available: true }
      : { available: false, reason: 'Unavailable until Stripe is configured' };
  }
  if (key === 'accounts_enabled') {
    if (!caps.authSecret) {
      return { available: false, reason: 'Unavailable until AUTH_SECRET is set' };
    }
    if (!emailConfigured(settings, caps)) {
      return { available: false, reason: 'Unavailable until email is enabled and configured' };
    }
  }
  if (key === 'image_optimize' && !caps.images) {
    return { available: false, reason: 'Unavailable until the IMAGES binding is added' };
  }
  return { available: true };
}

export function semanticSearchAvailable(caps: RuntimeCapabilities): boolean {
  return caps.ai && caps.vectorize;
}

export function lightningConfigurationError(
  backend: 'lnbits' | 'phoenixd',
  url: string,
  hasCredential: boolean,
): string | null {
  const label = backend === 'lnbits' ? 'LNbits' : 'phoenixd';
  if (!url) return `Add the ${label} URL.`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return `Enter a valid HTTP(S) URL for ${label}.`;
    }
  } catch {
    return `Enter a valid HTTP(S) URL for ${label}.`;
  }
  if (!hasCredential) {
    return backend === 'lnbits'
      ? 'Add the LNbits invoice/read key.'
      : 'Add the phoenixd password.';
  }
  return null;
}

export function turnstileConfigured(
  settings: StoreSettings,
  caps: RuntimeCapabilities,
): boolean {
  return (
    caps.vault &&
    !!settings.turnstileSiteKey &&
    settings.configuredSecrets.includes('turnstile_secret_key')
  );
}
