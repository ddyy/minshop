import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import { getSetting, setSetting } from '../settings/db';
import { decryptSecret, encryptSecret } from './crypto';

/**
 * Provider-key vault. Every sensitive provider key (Stripe, OpenNode, Resend,
 * Turnstile, Lightning) is set in the admin dashboard and stored as an `enc:<name>`
 * settings row in D1, AES-256-GCM-encrypted under the SECRETS_KEK Worker secret
 * (see ./crypto). There is NO env-var path — a clone is reconfigured entirely from
 * the dashboard. A D1 leak alone yields only ciphertext (you need the KEK too). The
 * KEK is the one irreducible Worker secret; without it the vault is dormant and the
 * store runs demo-only. Keys are write-only from the UI: stored, never rendered back.
 */
export type SecretName =
  | 'stripe_secret_key'
  | 'stripe_webhook_secret'
  | 'opennode_api_key'
  | 'resend_api_key'
  | 'turnstile_secret_key'
  | 'lnbits_api_key'
  | 'phoenixd_password';

export const SECRET_NAMES: readonly SecretName[] = [
  'stripe_secret_key',
  'stripe_webhook_secret',
  'opennode_api_key',
  'resend_api_key',
  'turnstile_secret_key',
  'lnbits_api_key',
  'phoenixd_password',
];

/** D1 settings-row key holding the encrypted blob for a secret. */
const encKey = (name: SecretName) => `enc:${name}` as const;

const nonEmpty = (v: string | undefined | null): string | null => (v && v.length > 0 ? v : null);

/** The KEK (Worker secret), or null when the vault is dormant. */
function kek(): string | null {
  return nonEmpty(env.SECRETS_KEK);
}

/** Whether the encrypted-secret vault is usable (a SECRETS_KEK is configured). */
export function vaultReady(): boolean {
  return kek() !== null;
}

/**
 * Resolve a secret's plaintext value from the encrypted D1 vault, or null when it's
 * unset / the vault is dormant / the KEK can't decrypt it. Used at
 * checkout/webhook/refund time — not per page render.
 */
export async function getSecret(db: D1Database, name: SecretName): Promise<string | null> {
  const k = kek();
  if (!k) return null;
  const blob = await getSetting(db, encKey(name));
  if (!blob) return null;
  return decryptSecret(k, blob); // null if the KEK was rotated / ciphertext tampered
}

/**
 * Store (or clear) a secret encrypted in D1. Requires the KEK — without it we refuse
 * rather than write plaintext. An empty value deletes the row.
 */
export async function setSecret(
  db: D1Database,
  name: SecretName,
  plaintext: string | null | undefined,
): Promise<void> {
  const k = kek();
  if (!k) throw new Error('Cannot store keys: set the SECRETS_KEK Worker secret first.');
  if (!plaintext) {
    await setSetting(db, encKey(name), null);
    return;
  }
  await setSetting(db, encKey(name), await encryptSecret(k, plaintext.trim()));
}
