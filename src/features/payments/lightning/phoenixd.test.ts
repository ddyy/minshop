import { describe, it, expect, afterEach, vi } from 'vitest';
import { createPhoenixdBackend } from './phoenixd';

const URL = 'https://ln.example.com';
const PW = 'limited-access-password';

async function sign(payload: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(PW),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

afterEach(() => vi.unstubAllGlobals());

describe('phoenixd backend', () => {
  it('createInvoice maps serialized→bolt11 and posts amountSat', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ serialized: 'lnbc1...', paymentHash: 'abc123' }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const inv = await createPhoenixdBackend(URL, PW).createInvoice({
      amountSat: 1234,
      description: 'order',
    });
    expect(inv).toEqual({ bolt11: 'lnbc1...', paymentHash: 'abc123' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ln.example.com/createinvoice');
    expect((init as RequestInit).body?.toString()).toContain('amountSat=1234');
  });

  it('getIncoming reports paid, and 404 → not paid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ isPaid: true, receivedSat: 1234 }), { status: 200 }),
      ),
    );
    expect(await createPhoenixdBackend(URL, PW).getIncoming('abc')).toEqual({
      paid: true,
      amountSat: 1234,
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    expect(await createPhoenixdBackend(URL, PW).getIncoming('abc')).toEqual({ paid: false });
  });

  it('verifyWebhook accepts a correctly-signed body', async () => {
    const payload = JSON.stringify({ type: 'payment_received', paymentHash: 'hash-1' });
    const headers = new Headers({ 'X-Phoenix-Signature': await sign(payload) });
    const evt = await createPhoenixdBackend(URL, PW).verifyWebhook(payload, headers);
    expect(evt).toEqual({ paymentHash: 'hash-1', paid: true });
  });

  it('verifyWebhook rejects a tampered/forged signature', async () => {
    const payload = JSON.stringify({ type: 'payment_received', paymentHash: 'hash-1' });
    const headers = new Headers({ 'X-Phoenix-Signature': 'deadbeef' });
    await expect(createPhoenixdBackend(URL, PW).verifyWebhook(payload, headers)).rejects.toThrow();
  });
});
