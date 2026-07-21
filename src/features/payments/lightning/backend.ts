/**
 * Inner port: a Lightning node that can mint and watch invoices. phoenixd and
 * LNbits are adapters for it. The self-rendered `LightningProvider` (which
 * implements the outer PaymentProvider port) is written once against THIS
 * interface, so adding another node type is one new adapter file.
 */

export interface CreateInvoiceParams {
  amountSat: number;
  description: string;
  /** Echoed back on settlement (we pass the order's public_id). */
  externalId?: string;
  expirySeconds?: number;
  /**
   * Per-invoice settlement callback URL. LNbits needs it set per invoice;
   * phoenixd ignores it (its webhook URL is global daemon config).
   */
  webhookUrl?: string;
}

export interface Invoice {
  /** BOLT11 payment request string — what we render as QR / lightning: link. */
  bolt11: string;
  /** Lowercase hex payment hash — the settlement key. */
  paymentHash: string;
}

export interface IncomingStatus {
  paid: boolean;
  amountSat?: number;
}

/** A normalized settlement notification from a backend webhook. */
export interface LightningWebhookEvent {
  paymentHash: string;
  paid: boolean;
}

export interface LightningBackend {
  /** Adapter id, also stored on the pending row: 'phoenixd' | 'lnbits'. */
  readonly name: string;
  createInvoice(params: CreateInvoiceParams): Promise<Invoice>;
  /** Poll a single invoice by payment hash (the settle-on-load fallback). */
  getIncoming(paymentHash: string): Promise<IncomingStatus>;
  /**
   * Verify an incoming settlement webhook and normalize it. Reads the backend's
   * own signature header from `headers`. Throws on an invalid/forged signature.
   */
  verifyWebhook(payload: string, headers: Headers): Promise<LightningWebhookEvent>;
}
