import { env } from 'cloudflare:workers';
import { getConfig } from '../../config';
import { getStoreSettings, type StoreSettings } from '../settings/db';
import { getSecret } from '../secrets/store';
import type { EmailProvider } from './provider';
import { createCloudflareEmail } from './cloudflare';
import { createResendEmail } from './resend';

export type { EmailProvider, EmailMessage } from './provider';

/**
 * The active email provider, or null when email is disabled/unconfigured (callers
 * treat null as "skip"). Configured entirely in the admin dashboard (D1): the
 * on/off switch, provider, and from-address are runtime settings; the Resend API
 * key lives encrypted in the vault. The build-time `config.email` supplies only the
 * fallback from-address/name. Async because it reads D1.
 *
 * Pass `settings` when the caller already has them (middleware puts them on
 * `locals.settings`, the webhook routes load them to pick a rail) — the settings
 * read is a full-table scan on a path that may already have done it, and on a
 * distant D1 primary each avoided round trip is worth ~100ms+.
 */
export async function getEmailProvider(
  settings?: StoreSettings,
): Promise<EmailProvider | null> {
  const s = settings ?? (await getStoreSettings(env.DB));
  if (!s.emailEnabled) return null;

  const cfg = getConfig().email;
  // Sender display name: explicit from-name → runtime store name → build-time default.
  const from = { email: s.emailFrom ?? cfg.from, name: s.emailFromName ?? s.storeName ?? cfg.fromName };

  if (s.emailProvider === 'resend') {
    const apiKey = await getSecret(env.DB, 'resend_api_key');
    if (!apiKey) return null;
    return createResendEmail(apiKey, from);
  }

  // 'cloudflare' — the send_email binding (Workers Paid plan).
  const binding = env.EMAIL;
  if (!binding) return null;
  return createCloudflareEmail(binding, from);
}
