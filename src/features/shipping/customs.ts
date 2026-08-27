/**
 * Customs declaration for international label quotes (Shippo / TGE).
 *
 * Product catalogue holds HS code + origin; order lines supply qty/value/name.
 * Pure helpers — no D1 / cloudflare:workers — so unit tests stay portable.
 */

import { toMajorUnits } from '../../money.ts';

export interface CustomsProductFields {
  hs_code: string | null;
  country_of_origin: string | null;
  customs_description: string | null;
  weight_grams: number | null;
  /** When 0, the line is digital and skipped. */
  requires_shipping: number;
}

export interface CustomsOrderLine {
  name: string;
  price_cents: number;
  quantity: number;
  product_id: number | null;
}

export interface CustomsLine {
  description: string;
  quantity: number;
  /** Per-unit value in major currency units. */
  unitValueMajor: number;
  /** Per-unit weight in grams (≥ 1). */
  unitWeightGrams: number;
  hsCode: string;
  /** ISO 3166-1 alpha-2. */
  originCountry: string;
}

export interface CustomsDeclaration {
  items: CustomsLine[];
  currency: string;
  /** Exporter EORI (TGE CollectionAddress / Shippo tax ids). */
  eori?: string;
  vatNumber?: string;
  /** Shippo certify_signer — usually the ship-from contact name. */
  certifySigner?: string;
}

export type CustomsBuildResult =
  | { ok: true; declaration: CustomsDeclaration }
  | {
      ok: false;
      /** Human-readable gaps, one product (or line) per entry. */
      missing: string[];
    };

/** Cross-border when ISO alpha-2 countries differ (case-insensitive). */
export function needsCustomsDeclaration(fromCountry: string, toCountry: string): boolean {
  const a = fromCountry.trim().toUpperCase();
  const b = toCountry.trim().toUpperCase();
  return a.length === 2 && b.length === 2 && a !== b;
}

/** Digits only, 6–13 chars (HS-6 through long national extensions). */
export function normalizeHsCode(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 13) return null;
  return digits;
}

export function normalizeOriginCountry(raw: string): string | null {
  const c = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

/**
 * Build a declaration from paid order lines + product customs fields.
 * `parcelWeightGrams` fills in when a product has no weight (split across units).
 */
export function buildCustomsDeclaration(input: {
  lines: CustomsOrderLine[];
  productsById: Map<number, CustomsProductFields>;
  currency: string;
  parcelWeightGrams: number;
  eori?: string;
  vatNumber?: string;
  certifySigner?: string;
}): CustomsBuildResult {
  const shippable = input.lines.filter((l) => {
    if (l.quantity <= 0) return false;
    if (l.product_id == null) return true;
    const p = input.productsById.get(l.product_id);
    return !p || p.requires_shipping === 1;
  });
  if (shippable.length === 0) {
    return { ok: false, missing: ['This order has no shippable line items to declare.'] };
  }

  const totalUnits = shippable.reduce((s, l) => s + l.quantity, 0);
  const fallbackUnitGrams = Math.max(
    1,
    Math.round(Math.max(1, input.parcelWeightGrams) / Math.max(1, totalUnits)),
  );

  const missing: string[] = [];
  const items: CustomsLine[] = [];

  for (const line of shippable) {
    if (line.product_id == null) {
      missing.push(`“${line.name}” has no linked product — set HS code and origin on a product, or remove the line.`);
      continue;
    }
    const product = input.productsById.get(line.product_id);
    if (!product) {
      missing.push(`“${line.name}” (product #${line.product_id}) is missing from the catalogue.`);
      continue;
    }
    const hs = product.hs_code ? normalizeHsCode(product.hs_code) : null;
    const origin = product.country_of_origin
      ? normalizeOriginCountry(product.country_of_origin)
      : null;
    if (!hs) {
      missing.push(`“${line.name}” needs a customs HS code (Admin → product).`);
    }
    if (!origin) {
      missing.push(`“${line.name}” needs a country of origin (Admin → product).`);
    }
    if (!hs || !origin) continue;

    const desc = (product.customs_description ?? line.name).trim().slice(0, 200) || line.name;
    const unitWeight =
      product.weight_grams != null && product.weight_grams > 0
        ? product.weight_grams
        : fallbackUnitGrams;

    items.push({
      description: desc,
      quantity: line.quantity,
      unitValueMajor: toMajorUnits(line.price_cents, input.currency),
      unitWeightGrams: unitWeight,
      hsCode: hs,
      originCountry: origin,
    });
  }

  if (missing.length > 0) return { ok: false, missing };
  if (items.length === 0) {
    return { ok: false, missing: ['Could not build any customs lines for this order.'] };
  }

  return {
    ok: true,
    declaration: {
      items,
      currency: input.currency.toUpperCase(),
      ...(input.eori?.trim() && { eori: input.eori.trim() }),
      ...(input.vatNumber?.trim() && { vatNumber: input.vatNumber.trim() }),
      ...(input.certifySigner?.trim() && { certifySigner: input.certifySigner.trim() }),
    },
  };
}
