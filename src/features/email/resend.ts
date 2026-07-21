import type { EmailProvider, EmailMessage } from './provider';

/**
 * Resend adapter — a plain HTTPS call to the Resend API, so it works on the
 * Workers free plan (no `send_email` binding / paid plan needed). Get a free API
 * key at resend.com and paste it in Admin → Settings → Email (stored in the vault).
 */
export function createResendEmail(
  apiKey: string,
  from: { email: string; name: string },
): EmailProvider {
  const fromHeader = from.name ? `${from.name} <${from.email}>` : from.email;
  return {
    async send(msg: EmailMessage): Promise<void> {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: fromHeader,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Resend send failed (${res.status}): ${detail}`);
      }
    },
  };
}
