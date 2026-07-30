import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  buildShipmentPayload,
  findTransactionForRate,
  purchaseLabel,
  carrierCodeFor,
  distanceUnitFor,
  parseDimension,
  parseParcelForm,
  parseRates,
} from './labels';

const FROM = {
  name: 'My Shop',
  street1: '1 Store St',
  city: 'Springfield',
  state: 'IL',
  zip: '62701',
  country: 'us',
};
const TO = {
  name: 'Demo Shopper',
  line1: '123 Example Street',
  line2: null,
  city: 'Portland',
  state: 'OR',
  postal: '97205',
  country: 'us',
  email: 'buyer@example.com',
};

describe('buildShipmentPayload', () => {
  it('pins the wire shape: grams, uppercased countries, synchronous rating', () => {
    const payload = buildShipmentPayload(
      FROM,
      TO,
      { length: 30, width: 20, height: 10, weightGrams: 850 },
      'g',
    );
    expect(payload.async).toBe(false);
    const parcel = (payload.parcels as Array<Record<string, string>>)[0]!;
    // Grams are the canonical unit end to end — no conversion, no drift.
    expect(parcel).toEqual({
      length: '30',
      width: '20',
      height: '10',
      distance_unit: 'cm',
      weight: '850',
      mass_unit: 'g',
    });
    expect((payload.address_from as { country: string }).country).toBe('US');
    expect((payload.address_to as { country: string }).country).toBe('US');
    expect((payload.address_to as { email?: string }).email).toBe('buyer@example.com');
  });
  it('measures in inches for imperial stores', () => {
    expect(distanceUnitFor('lb')).toBe('in');
    expect(distanceUnitFor('oz')).toBe('in');
    expect(distanceUnitFor('g')).toBe('cm');
    expect(distanceUnitFor('kg')).toBe('cm');
  });
  it('omits empty street2 rather than sending a blank', () => {
    const payload = buildShipmentPayload(FROM, TO, { length: 1, width: 1, height: 1, weightGrams: 1 }, 'g');
    expect('street2' in (payload.address_to as object)).toBe(false);
  });
});

describe('parseParcelForm', () => {
  it('parses dimensions and converts weight from the store unit', () => {
    const result = parseParcelForm({ length: '12', width: '9', height: '3', weight: '2' }, 'lb');
    expect(result.parcel).toEqual({ length: 12, width: 9, height: 3, weightGrams: 907 });
  });
  it('refuses missing or non-positive fields with a message', () => {
    expect(parseParcelForm({ length: '', width: '9', height: '3', weight: '2' }, 'g').error).toMatch(/length/);
    expect(parseParcelForm({ length: '12', width: '9', height: '3', weight: '0' }, 'g').error).toMatch(/weight/);
    expect(parseParcelForm({ length: '12', width: '9', height: '3', weight: 'heavy' }, 'g').error).toMatch(/weight/);
  });
  it('bounds a single dimension at ten metres', () => {
    expect(parseDimension('1000')).toBe(1000);
    expect(parseDimension('1001')).toBeNull();
    expect(parseDimension('-1')).toBeNull();
  });
});

describe('parseRates', () => {
  it('extracts, prices in cents, and sorts cheapest first', () => {
    const rates = parseRates({
      rates: [
        { object_id: 'r2', amount: '12.50', currency: 'usd', provider: 'UPS', servicelevel: { name: 'Ground' }, estimated_days: 4 },
        { object_id: 'r1', amount: '7.33', currency: 'usd', provider: 'USPS', servicelevel: { name: 'Priority Mail' }, estimated_days: 2 },
        // Malformed entries vanish instead of poisoning the list.
        { amount: '1.00' },
        { object_id: 'r3', amount: 'free' },
      ],
    });
    expect(rates.map((r) => r.rateId)).toEqual(['r1', 'r2']);
    expect(rates[0]).toEqual({
      rateId: 'r1',
      provider: 'USPS',
      service: 'Priority Mail',
      amountCents: 733,
      currency: 'USD',
      estimatedDays: 2,
    });
  });
  it('returns empty for a shipment with no rates', () => {
    expect(parseRates({})).toEqual([]);
  });
});

describe('carrierCodeFor', () => {
  it('maps Shippo providers onto tracking codes, with a linkless fallback', () => {
    expect(carrierCodeFor('USPS')).toBe('usps');
    expect(carrierCodeFor('UPS')).toBe('ups');
    expect(carrierCodeFor('FedEx')).toBe('fedex');
    expect(carrierCodeFor('DHL Express')).toBe('dhl');
    expect(carrierCodeFor('Canada Post')).toBe('other');
  });
});

describe('purchase outcome classification', () => {
  // A purchase MOVES MONEY: only outcomes Shippo definitively judged may be
  // retried; anything ambiguous must park as `uncertain`.
  afterEach(() => vi.unstubAllGlobals());
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('a 4xx refusal is definite', async () => {
    respond(400, { detail: 'rate expired' });
    const result = await purchaseLabel('tok', 'rate_1', 'USPS', 'ord_1');
    expect(result).toEqual({ ok: false, error: 'rate expired', uncertain: false });
  });
  it('an ERROR transaction is definite', async () => {
    respond(200, { status: 'ERROR', messages: [{ text: 'address invalid' }] });
    const result = await purchaseLabel('tok', 'rate_1', 'USPS', 'ord_1');
    expect(result).toMatchObject({ ok: false, error: 'address invalid', uncertain: false });
  });
  it('a 5xx is ambiguous — the charge may have landed', async () => {
    respond(502, { detail: 'gateway' });
    const result = await purchaseLabel('tok', 'rate_1', 'USPS', 'ord_1');
    expect(result).toMatchObject({ ok: false, uncertain: true });
  });
  it('a network failure is ambiguous', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const result = await purchaseLabel('tok', 'rate_1', 'USPS', 'ord_1');
    expect(result).toMatchObject({ ok: false, uncertain: true });
  });
  it('a QUEUED answer without a label is ambiguous, not failed', async () => {
    respond(200, { status: 'QUEUED' });
    const result = await purchaseLabel('tok', 'rate_1', 'USPS', 'ord_1');
    expect(result).toMatchObject({ ok: false, uncertain: true });
  });
  it('a clean success carries the transaction id for the audit trail', async () => {
    respond(200, {
      status: 'SUCCESS',
      object_id: 'txn_9',
      tracking_number: '9400x',
      tracking_url_provider: 'https://t.example',
      label_url: 'https://l.example/x.pdf',
    });
    const result = await purchaseLabel('tok', 'rate_1', 'USPS', 'ord_1');
    expect(result).toEqual({
      ok: true,
      value: {
        transactionId: 'txn_9',
        trackingNumber: '9400x',
        trackingUrl: 'https://t.example',
        labelUrl: 'https://l.example/x.pdf',
        provider: 'USPS',
      },
    });
  });
  it('binds the order id into transaction metadata', async () => {
    const spy = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(JSON.stringify({ status: 'ERROR', echoed: !!init }), { status: 200 }),
    );
    vi.stubGlobal('fetch', spy);
    await purchaseLabel('tok', 'rate_1', 'USPS', 'ord_42');
    const body = JSON.parse(String(spy.mock.calls[0]?.[1]?.body));
    expect(body.metadata).toBe('order ord_42');
  });
});

describe('shipment payload metadata', () => {
  it('carries the order id so the dashboard can cross-reference', () => {
    const payload = buildShipmentPayload(FROM, TO, { length: 1, width: 1, height: 1, weightGrams: 1 }, 'g', 'ord_7');
    expect(payload.metadata).toBe('order ord_7');
  });
});

describe('findTransactionForRate', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (body: unknown, status = 200) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
  const tx = (over: Record<string, unknown> = {}) => ({
    object_id: 'txn_1',
    status: 'SUCCESS',
    rate: 'rate_1',
    tracking_number: '9400x',
    label_url: 'https://l.example/x.pdf',
    ...over,
  });
  const find = () => findTransactionForRate('tok', 'rate_1', 'USPS');

  it('treats an empty page as pending — absence is not proof of no purchase', async () => {
    respond({ results: [] });
    expect(await find()).toEqual({ ok: true, value: { state: 'pending' } });
  });
  it('treats a missing results property as inconclusive, changing nothing', async () => {
    respond({});
    expect((await find()).ok).toBe(false);
    respond({ results: 'nope' });
    expect((await find()).ok).toBe(false);
  });
  it("only an explicit terminal ERROR on OUR rate proves 'none'", async () => {
    respond({ results: [tx({ status: 'ERROR', object_id: 'txn_err' })] });
    expect(await find()).toEqual({ ok: true, value: { state: 'none' } });
  });
  it('a later SUCCESS is recoverable even beside an earlier ERROR', async () => {
    respond({ results: [tx({ status: 'ERROR', object_id: 'txn_err' }), tx()] });
    const result = await find();
    expect(result).toMatchObject({ ok: true, value: { state: 'purchased' } });
  });
  it('QUEUED, WAITING, and REFUNDPENDING stay pending — unresolved money', async () => {
    for (const status of ['QUEUED', 'WAITING', 'REFUNDPENDING']) {
      respond({ results: [tx({ status })] });
      expect(await find(), status).toEqual({ ok: true, value: { state: 'pending' } });
    }
  });
  it('REFUNDREJECTED means the purchased label stands', async () => {
    respond({ results: [tx({ status: 'REFUNDREJECTED' })] });
    expect(await find()).toMatchObject({ ok: true, value: { state: 'purchased' } });
  });
  it('REFUNDED is its own audited terminal state, carrying the original label', async () => {
    respond({ results: [tx({ status: 'REFUNDED' })] });
    const result = await find();
    expect(result).toMatchObject({
      ok: true,
      value: { state: 'refunded', label: { transactionId: 'txn_1', trackingNumber: '9400x' } },
    });
  });
  it('an incomplete SUCCESS is a reconciliation error, never a reopen', async () => {
    respond({ results: [tx({ label_url: undefined })] });
    expect((await find()).ok).toBe(false);
  });
  it('an unknown status is a reconciliation error, never a reopen', async () => {
    respond({ results: [tx({ status: 'SOMETHING_NEW' })] });
    expect((await find()).ok).toBe(false);
  });
  it('matches the rate EXACTLY — same-order metadata cannot substitute', async () => {
    // A different rate's transaction, even tagged with our order, is a
    // different attempt: it must not settle this one.
    respond({ results: [tx({ rate: 'rate_OTHER', metadata: 'order ord_42' })] });
    expect(await find()).toEqual({ ok: true, value: { state: 'pending' } });
  });
  it('accepts an expanded rate object as the exact match', async () => {
    respond({ results: [tx({ rate: { object_id: 'rate_1' } })] });
    expect(await find()).toMatchObject({ ok: true, value: { state: 'purchased' } });
  });
});
