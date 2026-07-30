import { describe, it, expect } from 'vitest';
import {
  buildShipmentPayload,
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
