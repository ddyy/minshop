/**
 * Shipping labels: shared types, form helpers, and the active provider factory.
 *
 * Vendor-specific HTTP lives in adapters (`shippo.ts`, `tge.ts`, …). This
 * module is the seam routes import so adding carriers does not rewrite the
 * order page.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { getSecret } from '../secrets/store.ts';
import { getSetting } from '../settings/db.ts';
import type { LabelProvider } from './labelProvider.ts';
import { createShippoLabelProvider } from './shippo.ts';
import { createTgeLabelProvider, type TgeEnvironment } from './tge.ts';

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
  createShippoLabelProvider,
} from './shippo.ts';

export {
  createTgeLabelProvider,
  fetchTgeRates,
  parseTgeRates,
  buildTgeQuotePayload,
} from './tge.ts';

export type LabelProviderId = 'shippo' | 'tge';

async function tgeCredentials(db: D1Database) {
  const apiKey = await getSecret(db, 'tge_api_key');
  const password = await getSecret(db, 'tge_api_password');
  if (!apiKey || !password) return null;
  const envRaw = (await getSetting(db, 'tge_environment')) ?? 'live';
  const environment: TgeEnvironment = envRaw === 'staging' ? 'staging' : 'live';
  return { apiKey, password, environment };
}

/**
 * The configured label backend, or null when none is set up.
 * Preference: `label_provider` setting when that adapter's secrets exist;
 * otherwise the only configured adapter (Shippo or TGE).
 */
export async function getLabelProvider(db: D1Database): Promise<LabelProvider | null> {
  const preferred = (await getSetting(db, 'label_provider')) as LabelProviderId | null;
  const shippoToken = await getSecret(db, 'shippo_api_key');
  const tge = await tgeCredentials(db);

  const shippo = shippoToken ? createShippoLabelProvider(shippoToken) : null;
  const tgeProvider = tge ? createTgeLabelProvider(tge) : null;

  if (preferred === 'tge' && tgeProvider) return tgeProvider;
  if (preferred === 'shippo' && shippo) return shippo;
  if (shippo && !tgeProvider) return shippo;
  if (tgeProvider && !shippo) return tgeProvider;
  if (shippo) return shippo;
  return tgeProvider;
}
