import type {
  LightningBackend,
  CreateInvoiceParams,
  Invoice,
  IncomingStatus,
  LightningWebhookEvent,
} from './backend';

/**
 * phoenixd backend — ACINQ's self-custodial headless Lightning daemon.
 * https://phoenix.acinq.co/server — HTTP API, Basic auth. Use the
 * `http-password-limited-access` password: it can create invoices + read
 * payments but cannot send funds, so a leaked store secret can't drain the node.
 *
 * Settlement is confirmed by re-polling the node (getIncoming), so the webhook is
 * treated as an untrusted "check this hash" nudge — its HMAC signature is
 * verified as defense-in-depth, but the node poll is the real authority.
 */
function basicAuth(password: string): string {
  // phoenixd uses an empty username; only the password matters.
  return `Basic ${btoa(`:${password}`)}`;
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createPhoenixdBackend(baseUrl: string, password: string): LightningBackend {
  const base = baseUrl.replace(/\/+$/, '');
  const auth = basicAuth(password);

  return {
    name: 'phoenixd',

    async createInvoice(p: CreateInvoiceParams): Promise<Invoice> {
      const body = new URLSearchParams();
      body.set('amountSat', String(p.amountSat));
      body.set('description', p.description);
      if (p.externalId) body.set('externalId', p.externalId);
      if (p.expirySeconds) body.set('expirySeconds', String(p.expirySeconds));

      const res = await fetch(`${base}/createinvoice`, {
        method: 'POST',
        headers: { Authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) throw new Error(`phoenixd createinvoice failed: ${res.status}`);
      const j = (await res.json()) as { serialized?: string; paymentHash?: string };
      if (!j.serialized || !j.paymentHash) throw new Error('phoenixd: malformed invoice response');
      return { bolt11: j.serialized, paymentHash: j.paymentHash };
    },

    async getIncoming(paymentHash: string): Promise<IncomingStatus> {
      const res = await fetch(`${base}/payments/incoming/${encodeURIComponent(paymentHash)}`, {
        headers: { Authorization: auth },
      });
      if (res.status === 404) return { paid: false };
      if (!res.ok) throw new Error(`phoenixd getIncoming failed: ${res.status}`);
      const j = (await res.json()) as { isPaid?: boolean; receivedSat?: number };
      return { paid: !!j.isPaid, amountSat: j.receivedSat };
    },

    async verifyWebhook(payload: string, headers: Headers): Promise<LightningWebhookEvent> {
      // Best-effort signature check (the node poll is the real authority). phoenixd
      // signs the raw body with HMAC-SHA256 keyed by the http password.
      const sig = headers.get('X-Phoenix-Signature');
      if (sig) {
        const expected = await hmacSha256Hex(password, payload);
        if (sig.toLowerCase() !== expected) throw new Error('phoenixd: bad webhook signature');
      }
      const j = JSON.parse(payload) as { type?: string; paymentHash?: string };
      if (!j.paymentHash) throw new Error('phoenixd: webhook missing paymentHash');
      return { paymentHash: j.paymentHash, paid: j.type === 'payment_received' };
    },
  };
}
