import type {
  LightningBackend,
  CreateInvoiceParams,
  Invoice,
  IncomingStatus,
  LightningWebhookEvent,
} from './backend';

/**
 * LNbits backend — works against a self-hosted instance or a hosted/community
 * one. Auth is the wallet's **Invoice/read key** (X-Api-Key), NOT the admin key,
 * so the store can only create + read invoices, never pay out.
 *
 * LNbits webhooks are UNSIGNED (a plain POST of the payment object), so we never
 * trust them on their own — verifyWebhook just extracts the hash, and the outer
 * LightningProvider re-polls getIncoming() to confirm settlement authoritatively.
 */
export function createLnbitsBackend(baseUrl: string, apiKey: string): LightningBackend {
  const base = baseUrl.replace(/\/+$/, '');
  const headers = { 'X-Api-Key': apiKey, 'content-type': 'application/json' };

  return {
    name: 'lnbits',

    async createInvoice(p: CreateInvoiceParams): Promise<Invoice> {
      const res = await fetch(`${base}/api/v1/payments`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          out: false,
          amount: p.amountSat, // LNbits invoice amounts are in sats
          memo: p.description,
          ...(p.expirySeconds ? { expiry: p.expirySeconds } : {}),
          ...(p.webhookUrl ? { webhook: p.webhookUrl } : {}),
          ...(p.externalId ? { extra: { externalId: p.externalId } } : {}),
        }),
      });
      if (!res.ok) throw new Error(`LNbits createinvoice failed: ${res.status}`);
      const j = (await res.json()) as { payment_hash?: string; payment_request?: string };
      if (!j.payment_request || !j.payment_hash) {
        throw new Error('LNbits: malformed invoice response');
      }
      return { bolt11: j.payment_request, paymentHash: j.payment_hash };
    },

    async getIncoming(paymentHash: string): Promise<IncomingStatus> {
      const res = await fetch(`${base}/api/v1/payments/${encodeURIComponent(paymentHash)}`, {
        headers: { 'X-Api-Key': apiKey },
      });
      if (res.status === 404) return { paid: false };
      if (!res.ok) throw new Error(`LNbits getIncoming failed: ${res.status}`);
      const j = (await res.json()) as { paid?: boolean };
      return { paid: !!j.paid };
    },

    async verifyWebhook(payload: string): Promise<LightningWebhookEvent> {
      const j = JSON.parse(payload) as { payment_hash?: string; paid?: boolean };
      if (!j.payment_hash) throw new Error('LNbits: webhook missing payment_hash');
      // Unsigned — `paid` is only a hint; the provider re-polls to confirm.
      return { paymentHash: j.payment_hash, paid: j.paid !== false };
    },
  };
}
