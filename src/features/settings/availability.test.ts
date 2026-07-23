import { describe, expect, it } from 'vitest';
import type { StoreSettings } from './db';
import {
  emailConfigured,
  featureAvailability,
  lightningConfigurationError,
  semanticSearchAvailable,
  stripeConfigured,
  turnstileConfigured,
  type RuntimeCapabilities,
} from './availability';

const settings = (overrides: Partial<StoreSettings> = {}): StoreSettings =>
  ({
    configuredSecrets: [],
    emailEnabled: false,
    emailProvider: 'resend',
    turnstileSiteKey: null,
    ...overrides,
  }) as StoreSettings;

const caps = (overrides: Partial<RuntimeCapabilities> = {}): RuntimeCapabilities => ({
  vault: false,
  authSecret: false,
  images: false,
  emailBinding: false,
  ai: false,
  vectorize: false,
  ...overrides,
});

describe('settings availability', () => {
  it('requires the vault and both Stripe secrets for Stripe-only features', () => {
    const configured = settings({
      configuredSecrets: ['stripe_secret_key', 'stripe_webhook_secret'],
    });
    expect(stripeConfigured(configured, caps({ vault: false }))).toBe(false);
    expect(stripeConfigured(configured, caps({ vault: true }))).toBe(true);
    expect(featureAvailability('discounts_enabled', configured, caps({ vault: false }))).toEqual({
      available: false,
      reason: 'Unavailable until Stripe is configured',
    });
  });

  it('requires a usable email provider for customer accounts', () => {
    const resend = settings({
      emailEnabled: true,
      emailProvider: 'resend',
      configuredSecrets: ['resend_api_key'],
    });
    expect(emailConfigured(resend, caps({ vault: true }))).toBe(true);
    expect(
      featureAvailability(
        'accounts_enabled',
        resend,
        caps({ vault: true, authSecret: true }),
      ),
    ).toEqual({ available: true });

    const cloudflare = settings({ emailEnabled: true, emailProvider: 'cloudflare' });
    expect(emailConfigured(cloudflare, caps({ emailBinding: false }))).toBe(false);
    expect(emailConfigured(cloudflare, caps({ emailBinding: true }))).toBe(true);
  });

  it('reports binding-backed features as unavailable when bindings are absent', () => {
    expect(featureAvailability('image_optimize', settings(), caps())).toEqual({
      available: false,
      reason: 'Unavailable until the IMAGES binding is added',
    });
    expect(semanticSearchAvailable(caps({ ai: true, vectorize: false }))).toBe(false);
    expect(semanticSearchAvailable(caps({ ai: true, vectorize: true }))).toBe(true);
  });

  it('requires both Turnstile keys and the vault', () => {
    const configured = settings({
      turnstileSiteKey: 'site-key',
      configuredSecrets: ['turnstile_secret_key'],
    });
    expect(turnstileConfigured(configured, caps({ vault: false }))).toBe(false);
    expect(turnstileConfigured(configured, caps({ vault: true }))).toBe(true);
  });

  it('requires the selected Lightning backend URL and credential', () => {
    expect(lightningConfigurationError('lnbits', '', true)).toBe('Add the LNbits URL.');
    expect(lightningConfigurationError('lnbits', 'ftp://node.example', true)).toBe(
      'Enter a valid HTTP(S) URL for LNbits.',
    );
    expect(lightningConfigurationError('lnbits', 'https://node.example', false)).toBe(
      'Add the LNbits invoice/read key.',
    );
    expect(lightningConfigurationError('phoenixd', 'https://node.example', false)).toBe(
      'Add the phoenixd password.',
    );
    expect(lightningConfigurationError('phoenixd', 'http://127.0.0.1:9740', true)).toBeNull();
  });
});
