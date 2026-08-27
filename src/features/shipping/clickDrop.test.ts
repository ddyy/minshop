import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildClickDropCreatePayload,
  clickDropDashboardUrl,
  isoOrderDate,
  packageFormatForWeightGrams,
  pushOrderToClickDrop,
} from './clickDrop';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const order = {
  public_id: 'ord_abc123',
  email: 'buyer@example.com',
  amount_total_cents: 2500,
  shipping_cents: 400,
  discount_cents: 0,
  tax_cents: 0,
  currency: 'GBP',
  shipping_weight_grams: 750,
  created_at: '2026-08-27 12:00:00',
};

const shipTo = {
  name: 'Ada Lovelace',
  line1: '1 Analytical Engine',
  line2: null,
  city: 'London',
  state: null,
  postal: 'SW1A 1AA',
  country: 'GB',
};

describe('packageFormatForWeightGrams', () => {
  it('picks formats by weight band', () => {
    expect(packageFormatForWeightGrams(50)).toBe('largeLetter');
    expect(packageFormatForWeightGrams(500)).toBe('smallParcel');
    expect(packageFormatForWeightGrams(5000)).toBe('mediumParcel');
    expect(packageFormatForWeightGrams(15000)).toBe('largeParcel');
  });
});

describe('isoOrderDate', () => {
  it('treats D1 naive timestamps as UTC', () => {
    expect(isoOrderDate('2026-08-27 12:00:00')).toBe('2026-08-27T12:00:00.000Z');
  });
});

describe('clickDropDashboardUrl', () => {
  it('points at the C&D order path', () => {
    expect(clickDropDashboardUrl(12345)).toBe(
      'https://business.parcel.royalmail.com/orders/12345',
    );
  });
});

describe('buildClickDropCreatePayload', () => {
  it('maps order + address + line items', () => {
    const body = buildClickDropCreatePayload({
      order,
      shipTo,
      items: [{ name: 'Widget', price_cents: 2100, quantity: 1 }],
    });
    const item = (body.items as Array<Record<string, unknown>>)[0]!;
    expect(item.orderReference).toBe('ord_abc123');
    expect(item.subtotal).toBe(21);
    expect(item.shippingCostCharged).toBe(4);
    expect(item.total).toBe(25);
    expect(item.currencyCode).toBe('GBP');
    const recipient = item.recipient as { address: { postcode: string; countryCode: string } };
    expect(recipient.address).toMatchObject({ postcode: 'SW1A 1AA', countryCode: 'GB' });
    const pkg = (item.packages as Array<{ weightInGrams: number; packageFormatIdentifier: string }>)[0]!;
    expect(pkg.weightInGrams).toBe(750);
    expect(pkg.packageFormatIdentifier).toBe('smallParcel');
  });
});

describe('pushOrderToClickDrop', () => {
  it('returns dashboard url on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            successCount: 1,
            errorsCount: 0,
            createdOrders: [{ orderIdentifier: 99, orderReference: 'ord_abc123' }],
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await pushOrderToClickDrop('key', {
      order,
      shipTo,
      items: [{ name: 'Widget', price_cents: 2100, quantity: 1 }],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        orderIdentifier: 99,
        orderReference: 'ord_abc123',
        dashboardUrl: 'https://business.parcel.royalmail.com/orders/99',
        trackingNumber: null,
      },
    });
  });

  it('surfaces create errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              successCount: 0,
              errorsCount: 1,
              failedOrders: [{ errors: [{ errorMessage: 'Invalid postcode' }] }],
            }),
            { status: 400 },
          ),
      ),
    );
    const result = await pushOrderToClickDrop('key', { order, shipTo, items: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Invalid postcode');
  });
});
