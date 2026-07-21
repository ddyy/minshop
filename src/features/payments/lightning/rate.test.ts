import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getBtcRate, fiatCentsToSats, clearRateCache } from './rate';

const URL_TMPL = 'https://api.example.com/prices/BTC-{currency}/spot';

beforeEach(() => clearRateCache());
afterEach(() => vi.unstubAllGlobals());

describe('fiatCentsToSats', () => {
  it('converts at the given BTC price (2-decimal currency)', () => {
    // $50.00 at $100,000/BTC = 0.0005 BTC = 50,000 sats
    expect(fiatCentsToSats(5000, 100_000, 'usd')).toBe(50_000);
  });

  it('rounds up so a rounding loss never under-charges', () => {
    // 1 cent at $100,000/BTC = 10 sats exactly
    expect(fiatCentsToSats(1, 100_000, 'usd')).toBe(10);
    // a non-integer result rounds up
    expect(fiatCentsToSats(1, 99_999, 'usd')).toBe(11);
  });

  it('scales by the currency minor unit — JPY has no sub-unit', () => {
    // ¥5000 stored as 5000. At ¥100,000/BTC = 0.05 BTC = 5,000,000 sats.
    // (The old cents/100 math would have under-charged 100× → 50,000 sats.)
    expect(fiatCentsToSats(5000, 100_000, 'jpy')).toBe(5_000_000);
  });

  it('scales by the currency minor unit — 3-decimal currency', () => {
    // BHD 5.000 stored as 5000 (×1000). At 50,000/BTC → 5·1e8/(50,000) = 10,000 sats.
    expect(fiatCentsToSats(5000, 50_000, 'bhd')).toBe(10_000);
  });
});

describe('getBtcRate', () => {
  it('fetches + parses a Coinbase-shaped response and substitutes the currency', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: { amount: '100000.00' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const rate = await getBtcRate('usd', URL_TMPL);
    expect(rate).toBe(100_000);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/prices/BTC-USD/spot',
      expect.anything(),
    );
  });

  it('caches within the TTL (one fetch for two calls)', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: { amount: '90000' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getBtcRate('eur', URL_TMPL);
    await getBtcRate('eur', URL_TMPL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));
    await expect(getBtcRate('usd', URL_TMPL)).rejects.toThrow();
  });

  it('throws on an unparseable price', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { amount: 'NaN' } }), { status: 200 })),
    );
    await expect(getBtcRate('usd', URL_TMPL)).rejects.toThrow();
  });
});
