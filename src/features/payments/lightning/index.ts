import { env } from 'cloudflare:workers';
import { getStoreSettings } from '../../settings/db';
import { getSecret } from '../../secrets/store';
import type { LightningBackend } from './backend';
import { createPhoenixdBackend } from './phoenixd';
import { createLnbitsBackend } from './lnbits';

export type { LightningBackend } from './backend';

/**
 * Returns the configured self-hosted Lightning node adapter (phoenixd | LNbits),
 * read from the admin config: the backend choice + node URL are D1 settings, the
 * key/password live in the encrypted vault. Throws a clear setup error if the chosen
 * backend isn't fully configured. Async because it reads D1.
 */
export async function getLightningBackend(): Promise<LightningBackend> {
  const s = await getStoreSettings(env.DB);

  if (s.lightningBackend === 'lnbits') {
    const url = s.lnbitsUrl;
    const key = await getSecret(env.DB, 'lnbits_api_key');
    if (!url || !key) {
      throw new Error('LNbits not configured: set the URL + invoice/read key in Settings → Payments.');
    }
    return createLnbitsBackend(url, key);
  }

  // Default: phoenixd.
  const url = s.phoenixdUrl;
  const pw = await getSecret(env.DB, 'phoenixd_password');
  if (!url || !pw) {
    throw new Error('phoenixd not configured: set the URL + password in Settings → Payments.');
  }
  return createPhoenixdBackend(url, pw);
}
