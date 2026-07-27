/**
 * Merchant-managed shipping: the runtime document, its parsing/validation, the
 * effective-configuration resolver, and the guarded saves.
 *
 * Shipping configuration lives as ONE versioned JSON document in `settings`. It is
 * small, bounded, and always consumed whole, so a single row buys atomic
 * replacement and adds nothing to the settings read the middleware already does.
 * Normalized tables would add joins, reorder operations, and partial-write windows
 * without improving a query anyone runs.
 *
 * `calculator.ts` stays pure shipping policy — all JSON and D1 concerns live here.
 */

import type { D1Database } from '@cloudflare/workers-types';
import {
  FREE_SHIPPING_LABEL,
  type RatePricing,
  type ShippingConfig,
  type WeightBand,
} from './calculator.ts';
import { CATCH_ALL, countryName, isCountryCode } from './countries.ts';
import { toGrams, type WeightUnit } from './weight.ts';
import { toMinorUnits } from '../../money.ts';

export const SHIPPING_CONFIG_KEY = 'shipping_config';

/** 1 = flat rates only. 2 adds pricing modes and the package-weight allowance. */
export const SHIPPING_SCHEMA_VERSION = 2;

export const SHIPPING_LIMITS = {
  zones: 20,
  countriesPerZone: 100,
  /** Stripe Checkout accepts at most five shipping options; hold every rail to the
   *  same ceiling so quotes cannot differ by rail. Free shipping counts. */
  resolvedOptionsPerZone: 5,
  bandsPerRate: 20,
  zoneName: 60,
  rateLabel: 60,
  json: 64 * 1024,
  amountMinorUnits: 999_999_999,
} as const;

export interface RuntimeShippingRate {
  label: string;
  pricing: RatePricing;
}

export interface RuntimeShippingZone {
  name: string;
  countries: string[];
  rates: RuntimeShippingRate[];
  freeOverCents: number | null;
}

export interface RuntimeShippingConfig {
  schema: number;
  revision: number;
  enabled: boolean;
  packageWeightGrams: number;
  zones: RuntimeShippingZone[];
}

/**
 * Absent and invalid must stay distinguishable: absent inherits build-time rates,
 * invalid fails closed. Collapsing both to `null` would silently restore possibly
 * cheaper build-time pricing over a corrupt document.
 */
export type ParsedRuntimeShippingConfig =
  | { status: 'absent' }
  | { status: 'valid'; config: RuntimeShippingConfig }
  | { status: 'invalid'; raw: string; error: string };

export interface ShippingValidationError {
  zoneIndex?: number;
  rateIndex?: number;
  bandIndex?: number;
  field?:
    | 'document'
    | 'packageWeight'
    | 'name'
    | 'countries'
    | 'label'
    | 'amount'
    | 'freeOver'
    | 'bands'
    | 'upTo';
  message: string;
}

// ── Validation ───────────────────────────────────────────────────────────────

function isAmount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= SHIPPING_LIMITS.amountMinorUnits
  );
}

function validateBands(bands: unknown, zoneIndex: number, rateIndex: number) {
  const errors: ShippingValidationError[] = [];
  if (!Array.isArray(bands) || bands.length === 0) {
    errors.push({ zoneIndex, rateIndex, field: 'bands', message: 'Add at least one weight band.' });
    return errors;
  }
  if (bands.length > SHIPPING_LIMITS.bandsPerRate) {
    errors.push({
      zoneIndex,
      rateIndex,
      field: 'bands',
      message: `At most ${SHIPPING_LIMITS.bandsPerRate} bands per service.`,
    });
    return errors;
  }
  let previous = 0;
  bands.forEach((band: WeightBand, bandIndex) => {
    const last = bandIndex === bands.length - 1;
    if (!isAmount(band?.amountCents)) {
      errors.push({ zoneIndex, rateIndex, bandIndex, field: 'amount', message: 'Enter a price.' });
    }
    if (band?.upToGrams == null) {
      if (!last) {
        errors.push({
          zoneIndex,
          rateIndex,
          bandIndex,
          field: 'upTo',
          message: 'Only the last band can have no maximum.',
        });
      }
      return;
    }
    if (!Number.isSafeInteger(band.upToGrams) || band.upToGrams <= 0) {
      errors.push({
        zoneIndex,
        rateIndex,
        bandIndex,
        field: 'upTo',
        message: 'Enter a weight above zero.',
      });
      return;
    }
    if (band.upToGrams <= previous) {
      errors.push({
        zoneIndex,
        rateIndex,
        bandIndex,
        field: 'upTo',
        message: 'Each band must be heavier than the one above it.',
      });
    }
    previous = band.upToGrams;
  });
  return errors;
}

/** Every invariant the storefront relies on. Used on save AND on read, so a
 *  hand-edited row cannot reach checkout through a path validation never saw. */
export function validateShippingDocument(doc: RuntimeShippingConfig): ShippingValidationError[] {
  const errors: ShippingValidationError[] = [];

  if (typeof doc.enabled !== 'boolean') {
    errors.push({ field: 'document', message: 'Enabled must be true or false.' });
  }
  if (!Number.isSafeInteger(doc.packageWeightGrams) || doc.packageWeightGrams < 0) {
    errors.push({ field: 'packageWeight', message: 'Enter a package weight of zero or more.' });
  }
  if (!Array.isArray(doc.zones)) {
    errors.push({ field: 'document', message: 'Zones must be a list.' });
    return errors;
  }
  if (doc.zones.length > SHIPPING_LIMITS.zones) {
    errors.push({ field: 'document', message: `At most ${SHIPPING_LIMITS.zones} zones.` });
  }
  if (doc.enabled && doc.zones.length === 0) {
    errors.push({
      field: 'document',
      message: 'Add at least one zone with one rate before turning shipping on.',
    });
  }

  const names = new Set<string>();
  const countries = new Set<string>();
  let catchAllIndex = -1;

  doc.zones.forEach((zone, zoneIndex) => {
    const name = (zone?.name ?? '').trim();
    if (!name) {
      errors.push({ zoneIndex, field: 'name', message: 'Name this zone.' });
    } else if (name.length > SHIPPING_LIMITS.zoneName) {
      errors.push({
        zoneIndex,
        field: 'name',
        message: `Keep the name under ${SHIPPING_LIMITS.zoneName} characters.`,
      });
    } else if (names.has(name.toLowerCase())) {
      errors.push({ zoneIndex, field: 'name', message: 'Another zone already uses this name.' });
    } else {
      names.add(name.toLowerCase());
    }

    const zoneCountries = Array.isArray(zone?.countries) ? zone.countries : [];
    if (zoneCountries.length === 0) {
      errors.push({ zoneIndex, field: 'countries', message: 'Choose at least one destination.' });
    }
    if (zoneCountries.length > SHIPPING_LIMITS.countriesPerZone) {
      errors.push({
        zoneIndex,
        field: 'countries',
        message: `At most ${SHIPPING_LIMITS.countriesPerZone} countries per zone.`,
      });
    }
    const hasCatchAll = zoneCountries.includes(CATCH_ALL);
    if (hasCatchAll) {
      if (zoneCountries.length > 1) {
        errors.push({
          zoneIndex,
          field: 'countries',
          message: 'Rest of world cannot be combined with specific countries.',
        });
      }
      if (catchAllIndex >= 0) {
        errors.push({
          zoneIndex,
          field: 'countries',
          message: 'Only one zone can be Rest of world.',
        });
      }
      catchAllIndex = zoneIndex;
    }
    for (const code of zoneCountries) {
      if (code === CATCH_ALL) continue;
      if (!isCountryCode(code)) {
        errors.push({ zoneIndex, field: 'countries', message: `${code} is not a country code.` });
        continue;
      }
      const cc = code.toUpperCase();
      if (countries.has(cc)) {
        errors.push({
          zoneIndex,
          field: 'countries',
          message: `${countryName(cc)} is already in another zone.`,
        });
      }
      countries.add(cc);
    }

    const rates = Array.isArray(zone?.rates) ? zone.rates : [];
    if (rates.length === 0) {
      errors.push({ zoneIndex, field: 'document', message: 'Add at least one shipping rate.' });
    }
    const freeOver = zone?.freeOverCents;
    if (freeOver != null && (!isAmount(freeOver) || freeOver <= 0)) {
      errors.push({ zoneIndex, field: 'freeOver', message: 'Enter an amount above zero.' });
    }
    const resolved = rates.length + (freeOver != null ? 1 : 0);
    if (resolved > SHIPPING_LIMITS.resolvedOptionsPerZone) {
      errors.push({
        zoneIndex,
        field: 'document',
        message:
          `A zone can offer at most ${SHIPPING_LIMITS.resolvedOptionsPerZone} options` +
          (freeOver != null ? ' (free shipping counts as one).' : '.'),
      });
    }

    const labels = new Set<string>();
    rates.forEach((rate, rateIndex) => {
      const label = (rate?.label ?? '').trim();
      if (!label) {
        errors.push({ zoneIndex, rateIndex, field: 'label', message: 'Name this rate.' });
      } else if (label.length > SHIPPING_LIMITS.rateLabel) {
        errors.push({
          zoneIndex,
          rateIndex,
          field: 'label',
          message: `Keep the label under ${SHIPPING_LIMITS.rateLabel} characters.`,
        });
      } else if (labels.has(label.toLowerCase())) {
        errors.push({
          zoneIndex,
          rateIndex,
          field: 'label',
          message: 'Another rate in this zone uses this label.',
        });
      } else if (freeOver != null && label.toLowerCase() === FREE_SHIPPING_LABEL.toLowerCase()) {
        // The free option is synthesized under this exact label; a configured rate
        // sharing it would make the shopper's choice ambiguous at settlement.
        errors.push({
          zoneIndex,
          rateIndex,
          field: 'label',
          message: `"${FREE_SHIPPING_LABEL}" is reserved while a free-shipping threshold is set.`,
        });
      } else {
        labels.add(label.toLowerCase());
      }

      const pricing = rate?.pricing;
      if (pricing?.type === 'flat') {
        if (!isAmount(pricing.amountCents)) {
          errors.push({ zoneIndex, rateIndex, field: 'amount', message: 'Enter a price.' });
        }
      } else if (pricing?.type === 'weight') {
        errors.push(...validateBands(pricing.bands, zoneIndex, rateIndex));
      } else {
        errors.push({ zoneIndex, rateIndex, field: 'amount', message: 'Choose a pricing mode.' });
      }
    });
  });

  if (catchAllIndex >= 0 && catchAllIndex !== doc.zones.length - 1) {
    errors.push({
      zoneIndex: catchAllIndex,
      field: 'countries',
      message: 'Rest of world must be the last zone.',
    });
  }

  return errors;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** Read the stored row. Never throws: a corrupt value is a state, not a crash. */
export function parseRuntimeShippingConfig(
  raw: string | null | undefined,
): ParsedRuntimeShippingConfig {
  if (raw == null || raw === '') return { status: 'absent' };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: 'invalid', raw, error: 'The stored shipping configuration is not valid JSON.' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { status: 'invalid', raw, error: 'The stored shipping configuration is not an object.' };
  }

  const doc = value as Partial<RuntimeShippingConfig>;
  if (typeof doc.schema !== 'number' || doc.schema < 1 || doc.schema > SHIPPING_SCHEMA_VERSION) {
    return {
      status: 'invalid',
      raw,
      error: `Unsupported shipping schema version ${String(doc.schema)}.`,
    };
  }
  if (!Number.isSafeInteger(doc.revision) || (doc.revision as number) < 0) {
    return { status: 'invalid', raw, error: 'The shipping configuration has no valid revision.' };
  }

  // Coercion is a SCHEMA 1 MIGRATION, not a parser. Applying it to a schema 2
  // document would turn corrupt values into plausible ones — `enabled: "yes"`
  // becoming `false` reads as "the merchant switched shipping off" and bypasses
  // checkout silently, which is the opposite of failing closed. So schema 2 is
  // validated as written; only an explicit schema 1 upgrade fills in defaults.
  const isLegacy = doc.schema < 2;
  if (!isLegacy) {
    if (typeof doc.enabled !== 'boolean') {
      return { status: 'invalid', raw, error: 'The shipping configuration has no valid on/off value.' };
    }
    if (!Number.isSafeInteger(doc.packageWeightGrams)) {
      return { status: 'invalid', raw, error: 'The shipping configuration has an invalid packaging weight.' };
    }
    if (!Array.isArray(doc.zones)) {
      return { status: 'invalid', raw, error: 'The shipping configuration has no zone list.' };
    }
    for (const zone of doc.zones) {
      if (
        typeof zone?.name !== 'string' ||
        !Array.isArray(zone?.countries) ||
        !zone.countries.every((c) => typeof c === 'string') ||
        !Array.isArray(zone?.rates) ||
        (zone.freeOverCents !== null && typeof zone.freeOverCents !== 'number')
      ) {
        return { status: 'invalid', raw, error: 'The shipping configuration has a malformed zone.' };
      }
      for (const rate of zone.rates) {
        if (typeof rate?.label !== 'string' || rate?.pricing == null) {
          return { status: 'invalid', raw, error: 'The shipping configuration has a malformed rate.' };
        }
      }
    }
  } else if (typeof doc.enabled !== 'boolean') {
    return { status: 'invalid', raw, error: 'The shipping configuration has no valid on/off value.' };
  }

  const normalized: RuntimeShippingConfig = {
    schema: doc.schema,
    revision: doc.revision as number,
    enabled: doc.enabled as boolean,
    // Schema 1 predates the package allowance and pricing modes; fill both in.
    packageWeightGrams: Number.isSafeInteger(doc.packageWeightGrams)
      ? (doc.packageWeightGrams as number)
      : 0,
    zones: (Array.isArray(doc.zones) ? doc.zones : []).map((zone) => ({
      name: typeof zone?.name === 'string' ? zone.name : '',
      countries: Array.isArray(zone?.countries) ? zone.countries.map(String) : [],
      rates: (Array.isArray(zone?.rates) ? zone.rates : []).map((rate) => {
        const legacy = rate as unknown as { label?: string; amountCents?: number };
        return {
          label: typeof rate?.label === 'string' ? rate.label : '',
          pricing:
            rate?.pricing ??
            ({ type: 'flat', amountCents: legacy.amountCents ?? NaN } as RatePricing),
        };
      }),
      freeOverCents: typeof zone?.freeOverCents === 'number' ? zone.freeOverCents : null,
    })),
  };

  const errors = validateShippingDocument(normalized);
  if (errors.length > 0) {
    return { status: 'invalid', raw, error: errors[0]!.message };
  }
  return { status: 'valid', config: normalized };
}

// ── Effective configuration ──────────────────────────────────────────────────

export interface ShippingConfigIssue {
  source: 'build-time' | 'admin';
  /** Safe to show a merchant: never the raw document. */
  reason: string;
}

export interface EffectiveShipping {
  config: ShippingConfig;
  source: 'build-time' | 'admin';
  /** Set when resolution failed closed — drives the persistent Admin banner. */
  issue: ShippingConfigIssue | null;
}

/** Build-time config is authored in TypeScript with no save-time validation, so the
 *  same invariants are checked on read. Over-cap zones would otherwise fail only at
 *  Stripe session creation, after the shopper has committed to checking out. */
export function validateBuildTimeShipping(cfg: ShippingConfig): string | null {
  const asDocument: RuntimeShippingConfig = {
    schema: SHIPPING_SCHEMA_VERSION,
    revision: 0,
    enabled: cfg.enabled,
    packageWeightGrams: cfg.packageWeightGrams ?? 0,
    zones: cfg.zones.map((zone, index) => ({
      // Build-time zones have no names; supply one so name rules cannot fail a
      // configuration the merchant has no way to edit from here.
      name: zone.name ?? `Zone ${index + 1}`,
      countries: zone.countries,
      rates: zone.rates.map((rate) =>
        'pricing' in rate
          ? { label: rate.label, pricing: rate.pricing }
          : { label: rate.label, pricing: { type: 'flat' as const, amountCents: rate.amountCents } },
      ),
      freeOverCents: zone.freeOverCents,
    })),
  };
  // A disabled store with no zones is a legitimate resting state, not a fault.
  if (!asDocument.enabled && asDocument.zones.length === 0) return null;
  const errors = validateShippingDocument(asDocument).filter(
    (e) =>
      // Build-time zones have no names, and a threshold-only zone with no rates is
      // legal there (the calculator still synthesizes free shipping for it) even
      // though the Admin editor requires a rate. Neither is a reason to stop
      // selling for a store that has always worked.
      e.field !== 'name' && e.message !== 'Add at least one shipping rate.',
  );
  return errors.length > 0 ? errors[0]!.message : null;
}

/**
 * The single resolution every checkout surface goes through.
 *
 * 1. No document: build-time zones, with the legacy `shipping_enabled` override.
 * 2. Valid document: it owns shipping completely, including `enabled`.
 * 3. Invalid document: fail closed — offer nothing rather than fall back to
 *    build-time rates that may be cheaper than what the merchant intended.
 *
 * Case 3 must stay `enabled: true` with zero zones. Checkout bypasses shipping
 * entirely when the effective configuration is DISABLED, so flipping this to
 * `enabled: false` would turn a corrupt document into free shipping instead of a
 * blocked checkout.
 */
export function effectiveShippingConfig(
  buildTime: ShippingConfig,
  parsed: ParsedRuntimeShippingConfig,
  legacyEnabled: boolean | null,
): EffectiveShipping {
  if (parsed.status === 'invalid') {
    return {
      config: { enabled: true, zones: [] },
      source: 'admin',
      issue: { source: 'admin', reason: parsed.error },
    };
  }

  if (parsed.status === 'valid') {
    return {
      config: {
        enabled: parsed.config.enabled,
        packageWeightGrams: parsed.config.packageWeightGrams,
        zones: parsed.config.zones,
      },
      source: 'admin',
      issue: null,
    };
  }

  const invalid = validateBuildTimeShipping(buildTime);
  if (invalid) {
    return {
      config: { enabled: true, zones: [] },
      source: 'build-time',
      issue: { source: 'build-time', reason: invalid },
    };
  }
  return {
    config: { ...buildTime, enabled: legacyEnabled ?? buildTime.enabled },
    source: 'build-time',
    issue: null,
  };
}

// ── Serialization and guarded saves ──────────────────────────────────────────

export function serializeRuntimeShippingConfig(config: RuntimeShippingConfig): string {
  return JSON.stringify(config);
}

/** SHA-256 (hex) over the UTF-8 bytes of the raw row. Both the page render and the
 *  POST compute it the same way, so the encoding is part of the contract. */
export async function fingerprintRawConfig(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type ShippingSaveResult =
  | { ok: true; config: RuntimeShippingConfig }
  | { ok: false; reason: 'conflict' | 'too_large' | 'invalid'; errors?: ShippingValidationError[] };

/**
 * Write revision N+1, guarded on the document still being at revision N.
 *
 * Inside `ON CONFLICT DO UPDATE`, `settings.value` is the row as it stands and
 * `excluded.value` is the row we proposed — so the guard reads the stored revision.
 * A failed guard makes the statement a no-op and `RETURNING` comes back empty,
 * which is the 409 signal. The first save has no row, so the plain insert wins.
 */
export async function saveRuntimeShippingConfig(
  db: D1Database,
  expectedRevision: number,
  config: Omit<RuntimeShippingConfig, 'schema' | 'revision'>,
): Promise<ShippingSaveResult> {
  const next: RuntimeShippingConfig = {
    schema: SHIPPING_SCHEMA_VERSION,
    revision: expectedRevision + 1,
    ...config,
  };
  const errors = validateShippingDocument(next);
  if (errors.length > 0) return { ok: false, reason: 'invalid', errors };

  const value = serializeRuntimeShippingConfig(next);
  if (new TextEncoder().encode(value).length > SHIPPING_LIMITS.json) {
    return { ok: false, reason: 'too_large' };
  }

  const row = await db
    .prepare(
      `INSERT INTO settings (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')
       WHERE json_valid(settings.value)
         AND CAST(json_extract(settings.value, '$.revision') AS INTEGER) = ?
       RETURNING value`,
    )
    .bind(SHIPPING_CONFIG_KEY, value, expectedRevision)
    .first<{ value: string }>();

  return row ? { ok: true, config: next } : { ok: false, reason: 'conflict' };
}

/**
 * Replace a document so malformed that the ordinary guard can never match it.
 *
 * Two protections, and both are load-bearing: the caller's fingerprint proves the
 * merchant is destroying the document they were shown, and binding the WHERE to the
 * value we just read closes the window in which another tab repairs the row between
 * that read and this write.
 */
export async function replaceInvalidShippingConfig(
  db: D1Database,
  expectedFingerprint: string,
  config: Omit<RuntimeShippingConfig, 'schema' | 'revision'>,
): Promise<ShippingSaveResult> {
  const current = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(SHIPPING_CONFIG_KEY)
    .first<{ value: string }>();
  if (!current) return { ok: false, reason: 'conflict' };
  if ((await fingerprintRawConfig(current.value)) !== expectedFingerprint) {
    return { ok: false, reason: 'conflict' };
  }

  const next: RuntimeShippingConfig = { schema: SHIPPING_SCHEMA_VERSION, revision: 1, ...config };
  const errors = validateShippingDocument(next);
  if (errors.length > 0) return { ok: false, reason: 'invalid', errors };

  const value = serializeRuntimeShippingConfig(next);
  if (new TextEncoder().encode(value).length > SHIPPING_LIMITS.json) {
    return { ok: false, reason: 'too_large' };
  }

  const row = await db
    .prepare(
      `UPDATE settings SET value = ?, updated_at = datetime('now')
        WHERE key = ? AND value = ?
        RETURNING value`,
    )
    .bind(value, SHIPPING_CONFIG_KEY, current.value)
    .first<{ value: string }>();

  return row ? { ok: true, config: next } : { ok: false, reason: 'conflict' };
}

// ── Admin form model ─────────────────────────────────────────────────────────

/**
 * The editor works in stable per-row tokens rather than array indexes, so removing
 * the second of five rows does not renumber the error paths of the other four.
 * Tokens are form-local and never persisted.
 */
export interface ShippingFormBand {
  token: string;
  upToValue: string;
  noMax: boolean;
  amountValue: string;
}

export interface ShippingFormRate {
  token: string;
  label: string;
  mode: 'flat' | 'weight';
  amountValue: string;
  bands: ShippingFormBand[];
}

export interface ShippingFormZone {
  token: string;
  name: string;
  countries: string[];
  rates: ShippingFormRate[];
  freeOverValue: string;
}

export interface ShippingFormModel {
  enabled: boolean;
  revision: number;
  packageWeightValue: string;
  zones: ShippingFormZone[];
}

let tokenSeq = 0;
const nextToken = (prefix: string) => `${prefix}_${(tokenSeq += 1).toString(36)}`;

function amountToValue(minor: number, currency: string): string {
  const major = minor / 10 ** (currency ? decimalsFor(currency) : 2);
  return String(major);
}

function decimalsFor(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() })
        .resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** Document → editable form model (for rendering an existing configuration). */
export function documentToForm(
  doc: RuntimeShippingConfig,
  currency: string,
  unit: WeightUnit,
  formatGrams: (grams: number, unit: WeightUnit) => string,
): ShippingFormModel {
  return {
    enabled: doc.enabled,
    revision: doc.revision,
    packageWeightValue: doc.packageWeightGrams ? formatGrams(doc.packageWeightGrams, unit) : '',
    zones: doc.zones.map((zone) => ({
      token: nextToken('z'),
      name: zone.name,
      countries: [...zone.countries],
      freeOverValue: zone.freeOverCents == null ? '' : amountToValue(zone.freeOverCents, currency),
      rates: zone.rates.map((rate) => ({
        token: nextToken('r'),
        label: rate.label,
        mode: rate.pricing.type,
        amountValue:
          rate.pricing.type === 'flat' ? amountToValue(rate.pricing.amountCents, currency) : '',
        bands:
          rate.pricing.type === 'weight'
            ? rate.pricing.bands.map((band) => ({
                token: nextToken('b'),
                upToValue: band.upToGrams == null ? '' : formatGrams(band.upToGrams, unit),
                noMax: band.upToGrams == null,
                amountValue: amountToValue(band.amountCents, currency),
              }))
            : [],
      })),
    })),
  };
}

/**
 * Build the first-render migration candidate from RAW build-time configuration.
 *
 * Deliberately not from the effective result: when build-time config is invalid the
 * storefront correctly sees zero zones, but Admin must still show the offending
 * values so they can be repaired. Zone names are generated because `ShippingConfig`
 * has none, and the generated names are then validated like any others.
 */
export function migrationCandidate(
  buildTime: ShippingConfig,
  legacyEnabled: boolean | null,
  currency: string,
): ShippingFormModel {
  return {
    enabled: legacyEnabled ?? buildTime.enabled,
    revision: 0,
    packageWeightValue: '',
    zones: buildTime.zones.map((zone, index) => ({
      token: nextToken('z'),
      name: zone.name ?? legacyZoneName(zone.countries, index),
      countries: [...zone.countries],
      freeOverValue: zone.freeOverCents == null ? '' : amountToValue(zone.freeOverCents, currency),
      rates: zone.rates.map((rate) => ({
        token: nextToken('r'),
        label: rate.label,
        mode: 'pricing' in rate ? rate.pricing.type : ('flat' as const),
        amountValue:
          'pricing' in rate
            ? rate.pricing.type === 'flat'
              ? amountToValue(rate.pricing.amountCents, currency)
              : ''
            : amountToValue(rate.amountCents, currency),
        bands:
          'pricing' in rate && rate.pricing.type === 'weight'
            ? rate.pricing.bands.map((band) => ({
                token: nextToken('b'),
                upToValue: band.upToGrams == null ? '' : String(band.upToGrams),
                noMax: band.upToGrams == null,
                amountValue: amountToValue(band.amountCents, currency),
              }))
            : [],
      })),
    })),
  };
}

/** Deterministic name for a legacy zone: the country for a single-country zone,
 *  "Rest of world" for a catch-all, and a positional fallback otherwise. */
export function legacyZoneName(countries: string[], index: number): string {
  if (countries.length === 1 && countries[0] === CATCH_ALL) return 'Rest of world';
  if (countries.length === 1 && isCountryCode(countries[0]!)) return countryName(countries[0]!);
  return `Zone ${index + 1}`;
}

// ── Form parsing ─────────────────────────────────────────────────────────────

interface FormLike {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
}

const str = (form: FormLike, name: string) => String(form.get(name) ?? '').trim();

const splitTokens = (raw: string, cap: number) =>
  [...new Set(raw.split(',').map((t) => t.trim()).filter(Boolean))].slice(0, cap);

/**
 * Parse the submitted editor into a form model plus a document.
 *
 * Order lists drive the parse (unreferenced fields are ignored and duplicate tokens
 * dropped), and every cap is applied before large arrays are built, so a tampered
 * payload cannot make this expensive.
 */
export function parseShippingForm(
  form: FormLike,
  options: { currency: string; unit: WeightUnit },
): {
  model: ShippingFormModel;
  document: Omit<RuntimeShippingConfig, 'schema' | 'revision'>;
  revision: number;
  errors: ShippingValidationError[];
} {
  const { currency, unit } = options;
  const errors: ShippingValidationError[] = [];
  const revision = Number(str(form, 'revision'));

  const packageWeightValue = str(form, 'package_weight');
  let packageWeightGrams = 0;
  if (packageWeightValue !== '') {
    const parsed = toGrams(packageWeightValue, unit);
    if (parsed.status === 'ok') packageWeightGrams = parsed.grams;
    else if (parsed.status === 'error') {
      errors.push({ field: 'packageWeight', message: weightErrorMessage(parsed.reason, unit) });
    }
  }

  const zoneTokens = splitTokens(str(form, 'zone_order'), SHIPPING_LIMITS.zones);
  const zones: ShippingFormZone[] = [];
  const documentZones: RuntimeShippingZone[] = [];

  zoneTokens.forEach((zoneToken, zoneIndex) => {
    const prefix = `zone[${zoneToken}]`;
    const name = str(form, `${prefix}[name]`);
    const countries = form
      .getAll(`${prefix}[countries][]`)
      .map((v) => String(v).trim().toUpperCase())
      .filter(Boolean)
      .slice(0, SHIPPING_LIMITS.countriesPerZone);

    const freeOverValue = str(form, `${prefix}[free_over]`);
    let freeOverCents: number | null = null;
    if (freeOverValue !== '') {
      const major = Number(freeOverValue);
      if (!Number.isFinite(major) || major < 0) {
        errors.push({ zoneIndex, field: 'freeOver', message: 'Enter an amount above zero.' });
      } else {
        freeOverCents = toMinorUnits(major, currency);
      }
    }

    const rateTokens = splitTokens(
      str(form, `${prefix}[rate_order]`),
      SHIPPING_LIMITS.resolvedOptionsPerZone,
    );
    const rates: ShippingFormRate[] = [];
    const documentRates: RuntimeShippingRate[] = [];

    rateTokens.forEach((rateToken, rateIndex) => {
      const ratePrefix = `${prefix}[rate][${rateToken}]`;
      const label = str(form, `${ratePrefix}[label]`);
      const mode = str(form, `${ratePrefix}[mode]`) === 'weight' ? 'weight' : 'flat';
      const amountValue = str(form, `${ratePrefix}[amount]`);

      const bandTokens =
        mode === 'weight'
          ? splitTokens(str(form, `${ratePrefix}[band_order]`), SHIPPING_LIMITS.bandsPerRate)
          : [];
      const bands: ShippingFormBand[] = [];
      const documentBands: WeightBand[] = [];

      bandTokens.forEach((bandToken, bandIndex) => {
        const bandPrefix = `${ratePrefix}[band][${bandToken}]`;
        const upToValue = str(form, `${bandPrefix}[up_to]`);
        const noMax = form.get(`${bandPrefix}[no_max]`) != null;
        const bandAmountValue = str(form, `${bandPrefix}[amount]`);
        bands.push({ token: bandToken, upToValue, noMax, amountValue: bandAmountValue });

        let upToGrams: number | null = null;
        if (!noMax) {
          const parsed = toGrams(upToValue, unit);
          if (parsed.status === 'ok') upToGrams = parsed.grams;
          else {
            errors.push({
              zoneIndex,
              rateIndex,
              bandIndex,
              field: 'upTo',
              message:
                parsed.status === 'blank'
                  ? 'Enter a maximum weight.'
                  : weightErrorMessage(parsed.reason, unit),
            });
            upToGrams = Number.NaN;
          }
        }
        const major = Number(bandAmountValue);
        const amountCents =
          bandAmountValue !== '' && Number.isFinite(major) && major >= 0
            ? toMinorUnits(major, currency)
            : Number.NaN;
        documentBands.push({ upToGrams, amountCents });
      });

      const major = Number(amountValue);
      const flatCents =
        amountValue !== '' && Number.isFinite(major) && major >= 0
          ? toMinorUnits(major, currency)
          : Number.NaN;

      rates.push({ token: rateToken, label, mode, amountValue, bands });
      documentRates.push({
        label,
        pricing:
          mode === 'weight'
            ? { type: 'weight', bands: documentBands }
            : { type: 'flat', amountCents: flatCents },
      });
    });

    zones.push({ token: zoneToken, name, countries, rates, freeOverValue });
    documentZones.push({ name, countries, rates: documentRates, freeOverCents });
  });

  const document = {
    enabled: form.get('enabled') != null,
    packageWeightGrams,
    zones: documentZones,
  };

  errors.push(
    ...validateShippingDocument({
      schema: SHIPPING_SCHEMA_VERSION,
      revision: revision + 1,
      ...document,
    }),
  );

  return {
    model: {
      enabled: document.enabled,
      revision: Number.isSafeInteger(revision) ? revision : 0,
      packageWeightValue,
      zones,
    },
    document,
    revision: Number.isSafeInteger(revision) ? revision : 0,
    errors,
  };
}

export function weightErrorMessage(
  reason: 'not_number' | 'negative' | 'precision' | 'over_limit',
  unit: WeightUnit,
): string {
  switch (reason) {
    case 'negative':
      return 'Weight cannot be negative.';
    case 'precision':
      return `Too many decimal places for ${unit}.`;
    case 'over_limit':
      return 'That weight is too heavy for parcel shipping.';
    default:
      return 'Enter a weight as a number.';
  }
}

/** Errors for one row, so the editor can render them beside the field. */
export function errorsFor(
  errors: ShippingValidationError[],
  zoneIndex?: number,
  rateIndex?: number,
  bandIndex?: number,
): ShippingValidationError[] {
  return errors.filter(
    (e) =>
      e.zoneIndex === zoneIndex && e.rateIndex === rateIndex && e.bandIndex === bandIndex,
  );
}
