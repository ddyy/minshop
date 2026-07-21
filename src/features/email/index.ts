import { env } from 'cloudflare:workers';
import { getConfig } from '../../config';
import { getStoreSettings } from '../settings/db';
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
 */
export async function getEmailProvider(): Promise<EmailProvider | null> {
  const s = await getStoreSettings(env.DB);
  if (!s.emailEnabled) return null;

  const cfg = getConfig().email;
  const from = { email: s.emailFrom ?? cfg.from, name: s.emailFromName ?? cfg.fromName };

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
