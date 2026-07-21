/**
 * Fiat→sats conversion for Lightning invoices. The store prices in fiat minor
 * units, but Lightning invoices are denominated in sats, so we fetch a BTC spot
 * price at invoice time. Cached briefly per-currency to avoid a price call on
 * every checkout. Source is config-driven (default Coinbase spot — no API key).
 */
import { minorUnitsPerMajor } from '../../../money';

interface CachedRate {
  fiatPerBtc: number;
  at: number;
}

const RATE_TTL_MS = 60_000;
const cache = new Map<string, CachedRate>();

/** Test seam: drop the in-memory rate cache. */
export function clearRateCache(): void {
  cache.clear();
}

/**
 * BTC spot price in `currency` (fiat units per 1 BTC). `rateUrl` is a template
 * with a `{currency}` placeholder. Expects a Coinbase-shaped `{ data: { amount } }`
 * response. Cached for 60s. Throws if the price can't be fetched/parsed.
 */
export async function getBtcRate(currency: string, rateUrl: string): Promise<number> {
  const cur = currency.toUpperCase();
  const hit = cache.get(cur);
  if (hit && Date.now() - hit.at < RATE_TTL_MS) return hit.fiatPerBtc;

  const url = rateUrl.replace('{currency}', cur);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`BTC rate fetch failed: ${res.status}`);
  const body = (await res.json()) as { data?: { amount?: string } };
  const fiatPerBtc = Number(body?.data?.amount);
  if (!Number.isFinite(fiatPerBtc) || fiatPerBtc <= 0) {
    throw new Error(`BTC rate unparseable for ${cur}`);
  }
  cache.set(cur, { fiatPerBtc, at: Date.now() });
  return fiatPerBtc;
}

/**
 * Convert integer fiat minor units to whole sats at the given BTC price, scaled
 * by the currency's minor-unit size (so JPY, with no sub-unit, isn't under-charged
 * 100×). sats = (minor ÷ minorPerMajor) fiat ÷ fiatPerBtc × 1e8 (sats/BTC).
 * For USD (minorPerMajor=100) this is the familiar minor·1e6 ÷ fiatPerBtc.
 * Rounds up so a rounding loss never under-charges the order.
 */
export function fiatCentsToSats(cents: number, fiatPerBtc: number, currency: string): number {
  return Math.ceil((cents * 100_000_000) / (minorUnitsPerMajor(currency) * fiatPerBtc));
}
