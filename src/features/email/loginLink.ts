import type { EmailMessage } from './provider';
import { PALETTE, emailShell, emailButton } from './layout';

/** Passwordless sign-in email — a single-use, short-lived magic link. */
export function loginLinkEmail(to: string, link: string, storeName: string): EmailMessage {
  const subject = `Sign in to ${storeName}`;
  const text = `Click to sign in to ${storeName}:\n\n${link}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`;
  const html = emailShell({
    storeName,
    heading: 'Sign in',
    subheading: 'This link expires in 15 minutes and can only be used once.',
    body:
      emailButton(link, 'Sign in') +
      `<p style="margin:0;font-size:12px;line-height:1.6;color:${PALETTE.muted};">
        Button not working? Paste this into your browser:<br>
        <a href="${link}" style="color:${PALETTE.muted};word-break:break-all;">${link}</a>
      </p>`,
    footer: "If you didn't request this, you can safely ignore this email.",
  });
  return { to, subject, html, text };
}
