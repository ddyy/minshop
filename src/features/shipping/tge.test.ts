import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTgeQuotePayload,
  createTgeLabelProvider,
  decodeTgeShipmentId,
  encodeTgeShipmentId,
  labelUrlFromTge,
  parseTgeRates,
  pickTgeLabel,
  splitPersonName,
} from './tge';
import type { LabelRate } from './labelProvider';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const from = {
  name: 'Ada Lovelace',
  street1: '1 Analytical Engine',
  city: 'London',
  state: '',
  zip: 'SW1A 1AA',
  country: 'GB',
  email: 'ship@example.com',
  phone: '02079460000',
};

const to = {
  name: 'Charles Babbage',
  line1: '2 Difference St',
  line2: null,
  city: 'Manchester',
  state: null,
  postal: 'M1 1AE',
  country: 'GB',
  email: 'buyer@example.com',
};

const parcel = { length: 30, width: 20, height: 10, weightGrams: 1500 };

describe('splitPersonName', () => {
  it('splits forename and surname', () => {
    expect(splitPersonName('Ada Lovelace')).toEqual({ forename: 'Ada', surname: 'Lovelace' });
  });
  it('uses a dash surname for a single token', () => {
    expect(splitPersonName('Store')).toEqual({ forename: 'Store', surname: '-' });
  });
});

describe('buildTgeQuotePayload', () => {
  it('sends kg/cm and order summary', () => {
    const body = buildTgeQuotePayload(from, to, parcel, 'g', 42.5, 'GBP', 'ord_abc');
    const shipment = body.Shipment as {
      Consignment: {
        ConsignmentSummary: string;
        ConsignmentValue: number;
        Packages: Array<{ Weight: number; Length: number }>;
      };
      CollectionAddress: { Forename: string; Surname: string; EmailAddress: string };
    };
    expect(shipment.Consignment.ConsignmentSummary).toBe('Order ord_abc');
    expect(shipment.Consignment.ConsignmentValue).toBe(42.5);
    expect(shipment.Consignment.Packages[0]).toMatchObject({ Weight: 1.5, Length: 30 });
    expect(shipment.CollectionAddress).toMatchObject({
      Forename: 'Ada',
      Surname: 'Lovelace',
      EmailAddress: 'ship@example.com',
    });
  });

  it('converts inches to cm when the store uses lb', () => {
    const body = buildTgeQuotePayload(from, to, { ...parcel, length: 10 }, 'lb', 10, 'GBP');
    const pkg = (body.Shipment as { Consignment: { Packages: Array<{ Length: number }> } })
      .Consignment.Packages[0]!;
    expect(pkg.Length).toBeCloseTo(25.4, 5);
  });
});

describe('parseTgeRates', () => {
  it('maps services to LabelRate sorted by GBP gross without collection', () => {
    const rates = parseTgeRates([
      {
        ServiceID: 2,
        ServiceName: 'Slow',
        CarrierName: 'DPD',
        TransitTimeEstimate: '3+',
        TotalCost: { TotalCostGrossWithoutCollection: 12.5 },
      },
      {
        ServiceID: 1,
        ServiceName: 'Fast',
        CarrierName: 'DHL',
        TransitTimeEstimate: '1',
        TotalCost: { TotalCostGrossWithoutCollection: 9.99 },
      },
    ]);
    expect(rates).toEqual([
      {
        rateId: '1',
        provider: 'DHL',
        service: 'Fast',
        amountCents: 999,
        currency: 'GBP',
        estimatedDays: 1,
      },
      {
        rateId: '2',
        provider: 'DPD',
        service: 'Slow',
        amountCents: 1250,
        currency: 'GBP',
        estimatedDays: 3,
      },
    ]);
  });
});

describe('encodeTgeShipmentId / decodeTgeShipmentId', () => {
  it('round-trips quote id and rates', () => {
    const rates: LabelRate[] = [
      {
        rateId: '53',
        provider: 'DHL',
        service: 'Express',
        amountCents: 1000,
        currency: 'GBP',
        estimatedDays: 2,
      },
    ];
    const id = encodeTgeShipmentId(183, rates);
    expect(id.startsWith('tge:')).toBe(true);
    expect(decodeTgeShipmentId(id)).toEqual({ quoteId: 183, rates });
  });

  it('rejects non-tge ids', () => {
    expect(decodeTgeShipmentId('shippo_abc')).toBeNull();
  });
});

describe('pickTgeLabel / labelUrlFromTge', () => {
  it('prefers Primary Thermal then DownloadURL', () => {
    const label = pickTgeLabel([
      { LabelRole: 'Collection', LabelSize: 'A4', DownloadURL: 'https://x/c' },
      { LabelRole: 'Primary', LabelSize: 'A4', DownloadURL: 'https://x/a4' },
      { LabelRole: 'Primary', LabelSize: 'Thermal', DownloadURL: 'https://x/th' },
    ]);
    expect(label?.DownloadURL).toBe('https://x/th');
    expect(labelUrlFromTge(label!)).toBe('https://x/th');
  });

  it('falls back to a data URL when only LabelContent is present', () => {
    expect(labelUrlFromTge({ LabelContent: 'JVBERi0x' })).toBe(
      'data:application/pdf;base64,JVBERi0x',
    );
  });
});

describe('createTgeLabelProvider', () => {
  const creds = { apiKey: 'k', password: 'p', environment: 'staging' as const };

  it('refuses quote without email/phone', async () => {
    const provider = createTgeLabelProvider(creds);
    const result = await provider.fetchRates({
      from: { ...from, email: undefined, phone: undefined },
      to,
      parcel,
      weightUnit: 'g',
      consignmentValueMajor: 20,
      currency: 'GBP',
    });
    expect(result.ok).toBe(false);
  });

  it('quotes, re-lists via shipment id, and books', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('GetQuote')) {
        return new Response(
          JSON.stringify({
            Status: 'SUCCESS',
            QuoteID: 99,
            ServiceResults: [
              {
                ServiceID: 7,
                ServiceName: 'TG Parcel',
                CarrierName: 'Royal Mail',
                TransitTimeEstimate: '2',
                TotalCost: { TotalCostGrossWithoutCollection: 5.5 },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          Status: 'SUCCESS',
          OrderReference: 'TP-1',
          TrackingURL: 'https://track.example/1',
          Labels: [
            {
              LabelRole: 'Primary',
              LabelSize: 'A4',
              AirWaybillReference: 'AWB1',
              DownloadURL: 'https://labels.example/1.pdf',
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createTgeLabelProvider(creds);
    const quoted = await provider.fetchRates({
      from,
      to,
      parcel,
      weightUnit: 'g',
      consignmentValueMajor: 20,
      currency: 'GBP',
      orderPublicId: 'ord_1',
    });
    expect(quoted.ok).toBe(true);
    if (!quoted.ok) return;
    expect(quoted.value.rates[0]?.provider).toBe('Royal Mail');

    const listed = await provider.getRates(quoted.value.shipmentId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    const bought = await provider.purchase(
      listed.value[0]!,
      'ord_1',
      quoted.value.shipmentId,
    );
    expect(bought).toMatchObject({
      ok: true,
      value: {
        transactionId: 'TP-1',
        trackingNumber: 'AWB1',
        labelUrl: 'https://labels.example/1.pdf',
      },
    });
    expect(provider.carrierCodeFor('Royal Mail')).toBe('royal_mail');
  });

  it('reports that reconcile is unavailable', async () => {
    const provider = createTgeLabelProvider(creds);
    const outcome = await provider.findTransactionForRate('7', 'DHL');
    expect(outcome.ok).toBe(false);
  });
});
