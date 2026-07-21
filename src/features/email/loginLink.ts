import type { EmailMessage } from './provider';

/** Passwordless sign-in email — a single-use, short-lived magic link. */
export function loginLinkEmail(to: string, link: string, storeName: string): EmailMessage {
  const subject = `Sign in to ${storeName}`;
  const text = `Click to sign in to ${storeName}:\n\n${link}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`;
  const html = `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="font-size: 18px;">Sign in to ${storeName}</h2>
      <p style="color:#444;">Click the button to sign in. This link expires in 15 minutes and can be used once.</p>
      <p style="margin: 24px 0;">
        <a href="${link}" style="background:#111827;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;">Sign in</a>
      </p>
      <p style="color:#888;font-size:12px;">If you didn't request this, you can ignore this email.</p>
    </div>`;
  return { to, subject, html, text };
}
