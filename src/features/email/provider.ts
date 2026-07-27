/**
 * Email port (ports-and-adapters), mirroring PaymentProvider / StorageProvider.
 * App code sends a message; the adapter (Cloudflare `EMAIL` binding today) handles
 * delivery.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Stable per-notification key (e.g. `customer-receipt/42`). Adapters that
   * support provider-side dedupe send it (Resend, 24h window); the Cloudflare
   * binding has no equivalent and ignores it — there the outbox's sent-marker
   * is the only duplicate protection, and at-least-once means a crash between
   * send and mark can duplicate. Optional so ad-hoc sends (test email, refund
   * notices) need not invent one.
   */
  idempotencyKey?: string;
}

export interface EmailProvider {
  send(msg: EmailMessage): Promise<void>;
}
