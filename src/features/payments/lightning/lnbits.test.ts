import { describe, it, expect, afterEach, vi } from 'vitest';
import { createLnbitsBackend } from './lnbits';

const URL = 'https://lnbits.example.com';
const KEY = 'invoice-read-key';

afterEach(() => vi.unstubAllGlobals());

describe('LNbits backend', () => {
  it('createInvoice maps payment_request→bolt11 and includes the per-invoice webhook', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ payment_hash: 'h1', payment_request: 'lnbc2...' }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const inv = await createLnbitsBackend(URL, KEY).createInvoice({
      amountSat: 500,
      description: 'order',
      webhookUrl: 'https://shop.example.com/api/webhook',
    });
    expect(inv).toEqual({ bolt11: 'lnbc2...', paymentHash: 'h1' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://lnbits.example.com/api/v1/payments');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      out: false,
      amount: 500,
      webhook: 'https://shop.example.com/api/webhook',
    });
    expect((init as RequestInit).headers).toMatchObject({ 'X-Api-Key': KEY });
  });

  it('getIncoming reports paid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ paid: true }), { status: 200 })),
    );
    expect(await createLnbitsBackend(URL, KEY).getIncoming('h1')).toEqual({ paid: true });
  });

  it('verifyWebhook extracts the payment hash (unsigned)', async () => {
    const evt = await createLnbitsBackend(URL, KEY).verifyWebhook(
      JSON.stringify({ payment_hash: 'h1', paid: true }),
      new Headers(),
    );
    expect(evt).toEqual({ paymentHash: 'h1', paid: true });
  });
});
