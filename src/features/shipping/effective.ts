/**
 * The one place a request turns settings into shipping configuration.
 *
 * Kept separate from `settings.ts` so that file stays free of `getConfig()` (which
 * reaches into the Worker env) and remains unit-testable. Everything here is glue:
 * resolution, per-isolate memoization, and the fail-closed log.
 */

import { getConfig } from '../../config';
import type { StoreSettings } from '../settings/db';
import {
  effectiveShippingConfig,
  validateBuildTimeShipping,
  type EffectiveShipping,
  type ParsedRuntimeShippingConfig,
} from './settings';
import type { ShippingConfig } from './calculator';

/** `store.config.ts` cannot change while the isolate lives, so validate it once
 *  rather than re-walking every zone on every request. */
const buildTimeValidity = new WeakMap<ShippingConfig, string | null>();

function buildTimeIssue(cfg: ShippingConfig): string | null {
  if (!buildTimeValidity.has(cfg)) buildTimeValidity.set(cfg, validateBuildTimeShipping(cfg));
  return buildTimeValidity.get(cfg) ?? null;
}

/** Structured, once per isolate per reason — a merchant-visible banner is the real
 *  signal (see AdminLayout); this is for whoever is reading logs after the fact. */
const loggedIssues = new Set<string>();

function logIssue(source: string, reason: string) {
  const key = `${source}:${reason}`;
  if (loggedIssues.has(key)) return;
  loggedIssues.add(key);
  console.error(
    JSON.stringify({ event: 'shipping_config_invalid', source, reason }),
  );
}

/**
 * Resolve the shipping configuration for this request.
 *
 * Callers must consult `.config.enabled` (never `getConfig().shipping.enabled` or
 * the legacy `shipping_enabled` setting directly) — a saved Admin document owns
 * that value, and reading the build-time flag would silently ignore the merchant.
 */
export function shippingFor(settings: StoreSettings | null | undefined): EffectiveShipping {
  const buildTime = getConfig().shipping;
  const parsed: ParsedRuntimeShippingConfig = settings?.shippingConfig ?? { status: 'absent' };

  // Memoized build-time verdict, so the resolver does not re-validate per request.
  if (parsed.status === 'absent') {
    const invalid = buildTimeIssue(buildTime);
    if (invalid) {
      logIssue('build-time', invalid);
      return {
        config: { enabled: true, zones: [] },
        source: 'build-time',
        issue: { source: 'build-time', reason: invalid },
      };
    }
  }

  const effective = effectiveShippingConfig(buildTime, parsed, settings?.shippingEnabled ?? null);
  if (effective.issue) logIssue(effective.issue.source, effective.issue.reason);
  return effective;
}
