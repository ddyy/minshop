/**
 * Transglobal Express (services3) label-provider adapter.
 *
 * Uses V2 GetQuote + BookShipment (JSON). Quote Minimal cannot produce a
 * bookable QuoteID, so we always call the full GetQuote. Rates are GBP.
 *
 * Opaque shipment ids embed QuoteID + the rate list (TGE has no “get quote by
 * id” endpoint for re-listing services). Reconcile has no order-lookup API —
 * findTransactionForRate always reports that fact so the merchant uses the
 * TGE dashboard + force-discard path.
 *
 * Docs: https://services3.transglobalexpress.co.uk/Documentation/
 */

import type { CustomsDeclaration } from './customs.ts';
import {
  defaultCarrierCodeFor,
  distanceUnitFor,
  type LabelProvider,
  type LabelQuoteInput,
  type LabelRate,
  type LabelResult,
  type OrderShipTo,
  type ParcelInput,
  type PurchasedLabel,
  type ReconcileOutcome,
  type ShipFrom,
} from './labelProvider.ts';
import type { WeightUnit } from './weight.ts';

const LIVE_QUOTE = 'https://services3.transglobalexpress.co.uk/Quote/V2/GetQuote';
const LIVE_BOOK = 'https://services3.transglobalexpress.co.uk/Book/V2/BookShipment';
const STAGING_QUOTE = 'https://staging2.services3.transglobalexpress.co.uk/Quote/V2/GetQuote';
const STAGING_BOOK = 'https://staging2.services3.transglobalexpress.co.uk/Book/V2/BookShipment';

export type TgeEnvironment = 'live' | 'staging';

export interface TgeCredentials {
  apiKey: string;
  password: string;
  environment?: TgeEnvironment;
}

interface TgeNotification {
  Message?: string;
  Severity?: string;
}

interface TgeServiceResult {
  ServiceID?: number;
  ServiceName?: string;
  CarrierName?: string;
  TransitTimeEstimate?: string | null;
  TotalCost?: {
    TotalCostGrossWithoutCollection?: number;
    TotalCostGrossWithCollection?: number;
  };
}

interface TgeQuoteResponse {
  Status?: string;
  Notifications?: TgeNotification[];
  QuoteID?: number;
  ServiceResults?: TgeServiceResult[];
}

interface TgeLabel {
  LabelRole?: string;
  LabelSize?: string;
  AirWaybillReference?: string;
  LabelContent?: string;
  DownloadURL?: string;
  CarrierName?: string;
  ServiceName?: string;
}

interface TgeBookResponse {
  Status?: string;
  Notifications?: TgeNotification[];
  OrderReference?: string | null;
  Labels?: TgeLabel[];
  TrackingURL?: string | null;
}

function endpoints(env: TgeEnvironment): { quote: string; book: string } {
  return env === 'staging'
    ? { quote: STAGING_QUOTE, book: STAGING_BOOK }
    : { quote: LIVE_QUOTE, book: LIVE_BOOK };
}

function notifyText(notes: TgeNotification[] | undefined): string {
  return (notes ?? [])
    .map((n) => n.Message)
    .filter((m): m is string => !!m && m.trim().length > 0)
    .join(' ');
}

function gramsToKg(grams: number): number {
  return Math.max(0.01, Math.round((grams / 1000) * 1000) / 1000);
}

function toCm(value: number, weightUnit: WeightUnit): number {
  const n = distanceUnitFor(weightUnit) === 'in' ? value * 2.54 : value;
  return Math.round(n * 100) / 100;
}

/** Split "Ada Lovelace" → forename/surname; single token gets Surname "-". */
export function splitPersonName(full: string): { forename: string; surname: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { forename: 'Store', surname: '-' };
  if (parts.length === 1) return { forename: parts[0]!, surname: '-' };
  return { forename: parts[0]!, surname: parts.slice(1).join(' ') };
}

function tgeAddress(
  name: string,
  line1: string,
  line2: string | null | undefined,
  city: string,
  county: string | null | undefined,
  postcode: string,
  country: string,
  email: string,
  phone: string,
  residential: boolean,
) {
  const { forename, surname } = splitPersonName(name);
  return {
    Forename: forename,
    Surname: surname,
    EmailAddress: email,
    TelephoneNumber: phone,
    AddressLineOne: line1,
    ...(line2 && { AddressLineTwo: line2 }),
    City: city,
    ...(county && { County: county }),
    Postcode: postcode,
    Country: { CountryCode: country.toUpperCase() },
    IsAddressResidential: residential,
  };
}

/** Pure: map shared customs lines onto TGE CommodityDetails (kg + major value). */
export function tgeCommodityDetails(customs: CustomsDeclaration): Record<string, unknown>[] {
  return customs.items.map((line) => ({
    CommodityCode: line.hsCode,
    CommodityDescription: line.description,
    CountryOfOrigin: { CountryCode: line.originCountry },
    NumberOfUnits: line.quantity,
    UnitValue: line.unitValueMajor,
    UnitWeight: gramsToKg(line.unitWeightGrams),
  }));
}

/** Pure: GetQuote request body (credentials filled by the caller). */
export function buildTgeQuotePayload(
  from: ShipFrom,
  to: OrderShipTo,
  parcel: ParcelInput,
  weightUnit: WeightUnit,
  consignmentValueMajor: number,
  currency: string,
  orderPublicId?: string | null,
  customs?: CustomsDeclaration,
): Record<string, unknown> {
  const email = (from.email ?? '').trim();
  const phone = (from.phone ?? '').trim();
  const toEmail = (to.email ?? email).trim() || email;
  // Delivery phone is mandatory for TGE; reuse ship-from when the order has none.
  const toPhone = phone;
  const collection = {
    ...tgeAddress(
      from.name,
      from.street1,
      null,
      from.city,
      from.state || null,
      from.zip,
      from.country,
      email,
      phone,
      false,
    ),
    ...(customs?.eori && { EORINumber: customs.eori }),
    ...(customs?.vatNumber && { VATNumber: customs.vatNumber }),
  };
  return {
    Shipment: {
      Consignment: {
        ItemType: 'Parcel',
        ItemsAreStackable: true,
        ConsignmentSummary: orderPublicId ? `Order ${orderPublicId}` : 'Merchandise',
        ConsignmentValue: consignmentValueMajor,
        ConsignmentCurrency: { CurrencyCode: currency.toUpperCase() },
        Packages: [
          {
            Weight: gramsToKg(parcel.weightGrams),
            Length: toCm(parcel.length, weightUnit),
            Width: toCm(parcel.width, weightUnit),
            Height: toCm(parcel.height, weightUnit),
            ...(customs &&
              customs.items.length > 0 && {
                CommodityDetails: tgeCommodityDetails(customs),
              }),
          },
        ],
      },
      CollectionAddress: collection,
      DeliveryAddress: tgeAddress(
        to.name,
        to.line1,
        to.line2,
        to.city,
        to.state,
        to.postal,
        to.country,
        toEmail,
        toPhone,
        true,
      ),
    },
  };
}

/** Pure: map TGE service rows onto LabelRate (GBP gross, no collection). */
export function parseTgeRates(services: TgeServiceResult[] | undefined): LabelRate[] {
  return (services ?? [])
    .flatMap((s) => {
      if (s.ServiceID == null) return [];
      const gross = s.TotalCost?.TotalCostGrossWithoutCollection;
      const cents = Math.round(Number(gross) * 100);
      if (!Number.isFinite(cents) || cents < 0) return [];
      const daysMatch = String(s.TransitTimeEstimate ?? '').match(/(\d+)/);
      return [
        {
          rateId: String(s.ServiceID),
          provider: s.CarrierName ?? 'Transglobal',
          service: s.ServiceName ?? `Service ${s.ServiceID}`,
          amountCents: cents,
          currency: 'GBP',
          estimatedDays: daysMatch ? Number(daysMatch[1]) : null,
        },
      ];
    })
    .sort((a, b) => a.amountCents - b.amountCents);
}

/** Embed QuoteID + rates so getRates works without a TGE re-fetch API. */
export function encodeTgeShipmentId(quoteId: number, rates: LabelRate[]): string {
  const json = JSON.stringify({ q: quoteId, r: rates });
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `tge:${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export function decodeTgeShipmentId(
  shipmentId: string,
): { quoteId: number; rates: LabelRate[] } | null {
  if (!shipmentId.startsWith('tge:')) return null;
  const b64 = shipmentId.slice(4).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  try {
    const bin = atob(b64 + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      q?: number;
      r?: LabelRate[];
    };
    if (typeof parsed.q !== 'number' || !Array.isArray(parsed.r)) return null;
    return { quoteId: parsed.q, rates: parsed.r };
  } catch {
    return null;
  }
}

export function pickTgeLabel(labels: TgeLabel[] | undefined): TgeLabel | null {
  const list = labels ?? [];
  if (list.length === 0) return null;
  const primary = list.filter((l) => l.LabelRole === 'Primary');
  const pool = primary.length > 0 ? primary : list;
  return (
    pool.find((l) => l.LabelSize === 'Thermal') ??
    pool.find((l) => l.LabelSize === 'A4') ??
    pool[0] ??
    null
  );
}

export function labelUrlFromTge(label: TgeLabel): string | null {
  const url = label.DownloadURL?.trim();
  if (url) return url;
  const content = label.LabelContent?.trim();
  if (content) return `data:application/pdf;base64,${content}`;
  return null;
}

async function tgePost(
  url: string,
  credentials: TgeCredentials,
  body: Record<string, unknown>,
): Promise<LabelResult<unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        Credentials: { APIKey: credentials.apiKey, Password: credentials.password },
        ...body,
      }),
    });
  } catch {
    return { ok: false, error: 'Transglobal Express is unreachable right now.', uncertain: true };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return {
      ok: false,
      error: `Transglobal Express answered ${res.status} with an unreadable body.`,
      uncertain: res.ok || res.status >= 500,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      error: notifyText((json as TgeQuoteResponse).Notifications) || `Transglobal Express answered ${res.status}.`,
      uncertain: res.status >= 500,
    };
  }
  return { ok: true, value: json };
}

export async function fetchTgeRates(
  credentials: TgeCredentials,
  input: LabelQuoteInput,
): Promise<LabelResult<{ shipmentId: string; rates: LabelRate[] }>> {
  const email = (input.from.email ?? '').trim();
  const phone = (input.from.phone ?? '').trim();
  if (!email || !phone) {
    return {
      ok: false,
      error: 'Transglobal Express needs a ship-from email and phone number — add them on the label form.',
    };
  }
  const value = input.consignmentValueMajor;
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return { ok: false, error: 'Transglobal Express needs a positive consignment value for the quote.' };
  }
  const env = credentials.environment ?? 'live';
  if (
    input.from.country.toUpperCase() !== input.to.country.toUpperCase() &&
    (!input.customs || input.customs.items.length === 0)
  ) {
    return {
      ok: false,
      error:
        'International Transglobal quotes need a customs declaration — set HS code and country of origin on each product.',
    };
  }
  const result = await tgePost(
    endpoints(env).quote,
    credentials,
    buildTgeQuotePayload(
      input.from,
      input.to,
      input.parcel,
      input.weightUnit,
      value,
      input.currency ?? 'GBP',
      input.orderPublicId,
      input.customs,
    ),
  );
  if (!result.ok) return result;
  const quote = result.value as TgeQuoteResponse;
  if (quote.Status !== 'SUCCESS' && quote.Status !== 'PARTIAL') {
    return {
      ok: false,
      error: notifyText(quote.Notifications) || `Transglobal Express quote status: ${quote.Status ?? 'unknown'}.`,
    };
  }
  if (!quote.QuoteID || quote.QuoteID <= 0) {
    return {
      ok: false,
      error:
        notifyText(quote.Notifications) ||
        'Transglobal Express returned no bookable quote id — try again or check the addresses.',
    };
  }
  const rates = parseTgeRates(quote.ServiceResults);
  if (rates.length === 0) {
    return {
      ok: false,
      error: notifyText(quote.Notifications) || 'No Transglobal Express service offered a rate for this parcel.',
    };
  }
  return {
    ok: true,
    value: { shipmentId: encodeTgeShipmentId(quote.QuoteID, rates), rates },
  };
}

export function getTgeShipmentRates(shipmentId: string): LabelResult<LabelRate[]> {
  const decoded = decodeTgeShipmentId(shipmentId);
  if (!decoded) {
    return { ok: false, error: 'That Transglobal quote is not readable — fetch rates again.' };
  }
  if (decoded.rates.length === 0) {
    return { ok: false, error: 'That rate list has expired. Fetch rates again.' };
  }
  return { ok: true, value: decoded.rates };
}

export async function purchaseTgeLabel(
  credentials: TgeCredentials,
  shipmentId: string,
  rate: LabelRate,
  orderPublicId?: string | null,
): Promise<LabelResult<PurchasedLabel>> {
  const decoded = decodeTgeShipmentId(shipmentId);
  if (!decoded) {
    return { ok: false, error: 'That Transglobal quote is not readable — fetch rates again.' };
  }
  const serviceId = Number(rate.rateId);
  if (!Number.isFinite(serviceId)) {
    return { ok: false, error: 'Invalid Transglobal service id.' };
  }
  const env = credentials.environment ?? 'live';
  const result = await tgePost(endpoints(env).book, credentials, {
    QuoteSelection: { QuoteID: decoded.quoteId },
    BookDetails: {
      ServiceID: serviceId,
      ...(orderPublicId && { YourReference: orderPublicId }),
      SignatureRequired: false,
    },
  });
  if (!result.ok) return result;
  const book = result.value as TgeBookResponse;
  if (book.Status !== 'SUCCESS' && book.Status !== 'PARTIAL') {
    const definite = book.Status === 'FAIL' || book.Status === 'ERROR';
    return {
      ok: false,
      error: notifyText(book.Notifications) || 'Transglobal Express could not book that shipment.',
      uncertain: !definite,
    };
  }
  const label = pickTgeLabel(book.Labels);
  const labelUrl = label ? labelUrlFromTge(label) : null;
  const tracking =
    label?.AirWaybillReference?.trim() ||
    book.OrderReference?.trim() ||
    null;
  if (!book.OrderReference || !tracking || !labelUrl) {
    return {
      ok: false,
      error:
        notifyText(book.Notifications) ||
        'Transglobal Express booked the shipment but returned an incomplete label — check the TGE dashboard.',
      uncertain: true,
    };
  }
  return {
    ok: true,
    value: {
      transactionId: book.OrderReference,
      trackingNumber: tracking,
      trackingUrl: book.TrackingURL ?? null,
      labelUrl,
      provider: rate.provider,
    },
  };
}

export async function findTgeTransactionForRate(
  _rateId: string,
  _provider: string,
): Promise<LabelResult<ReconcileOutcome>> {
  return {
    ok: false,
    error:
      'Transglobal Express has no order-lookup API for reconciliation. Check the TGE dashboard for a booking with your order reference, then force-discard only if nothing was booked.',
  };
}

export function createTgeLabelProvider(credentials: TgeCredentials): LabelProvider {
  return {
    id: 'tge',
    fetchRates: (input) => fetchTgeRates(credentials, input),
    getRates: async (shipmentId) => getTgeShipmentRates(shipmentId),
    purchase: (rate, orderPublicId, shipmentId) => {
      if (!shipmentId) {
        return Promise.resolve({
          ok: false as const,
          error: 'Missing Transglobal quote id — fetch rates again.',
        });
      }
      return purchaseTgeLabel(credentials, shipmentId, rate, orderPublicId);
    },
    findTransactionForRate: (rateId, provider) => findTgeTransactionForRate(rateId, provider),
    carrierCodeFor: defaultCarrierCodeFor,
  };
}
