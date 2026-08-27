/**
 * Shipping labels: shared types, form helpers, and the active provider factory.
 *
 * Vendor-specific HTTP lives in adapters (`shippo.ts`, …). This module is the
 * seam routes import so adding Transglobal Express / Royal Mail does not
 * rewrite the order page.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { getSecret } from '../secrets/store.ts';
import type { LabelProvider } from './labelProvider.ts';
import { createShippoLabelProvider } from './shippo.ts';

export type {
  LabelProvider,
  LabelQuoteInput,
  LabelRate,
  LabelResult,
  OrderShipTo,
  ParcelFormResult,
  ParcelInput,
  PurchasedLabel,
  ReconcileOutcome,
  ShipFrom,
} from './labelProvider.ts';

export {
  defaultCarrierCodeFor as carrierCodeFor,
  distanceUnitFor,
  parseDimension,
  parseParcelForm,
} from './labelProvider.ts';

export {
  buildShipmentPayload,
  fetchLabelRates,
  findShippoTransactionForRate as findTransactionForRate,
  getShipmentRates,
  parseRates,
  purchaseLabel,
  createShippoLabelProvider,
} from './shippo.ts';

/**
 * The configured label backend, or null when none is set up.
 * Today: Shippo when `shippo_api_key` is in the vault.
 */
export async function getLabelProvider(db: D1Database): Promise<LabelProvider | null> {
  const token = await getSecret(db, 'shippo_api_key');
  return token ? createShippoLabelProvider(token) : null;
}
