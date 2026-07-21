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
}

export interface EmailProvider {
  send(msg: EmailMessage): Promise<void>;
}
