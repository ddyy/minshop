import type { D1Database } from '@cloudflare/workers-types';
import { constantTimeEqual } from './session.ts';

const ITERATIONS = 100_000;
const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function pbkdf2(code: string, salt: Uint8Array, iterations = ITERATIONS): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(code), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  ));
}

export async function hashMemberCode(code: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${hex(salt.buffer)}$${await pbkdf2(code, salt)}`;
}

export async function verifyMemberCode(code: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationsRaw, saltHex, expected] = encoded.split('$');
  const iterations = Number(iterationsRaw);
  if (algorithm !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || iterations < 10_000 || !saltHex || !expected) {
    return false;
  }
  const salt = new Uint8Array(saltHex.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? []);
  return constantTimeEqual(await pbkdf2(code, salt, iterations), expected);
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

/** Cookie payload; signed with AUTH_SECRET (same Worker secret as admin sessions). */
export async function signMemberSession(codeId: number, secret: string, now = Date.now() / 1000): Promise<string> {
  const payload = `v1.${codeId}.${Math.floor(now) + 30 * 24 * 60 * 60}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function memberSessionCodeId(
  token: string | undefined,
  secret: string,
  now = Date.now() / 1000,
): Promise<number | null> {
  if (!token) return null;
  const [version, idRaw, expRaw, signature, extra] = token.split('.');
  const id = Number(idRaw);
  const exp = Number(expRaw);
  if (extra || version !== 'v1' || !Number.isInteger(id) || id < 1 || !Number.isFinite(exp) || exp <= now) {
    return null;
  }
  const expected = await hmac(secret, `${version}.${idRaw}.${expRaw}`);
  return constantTimeEqual(signature, expected) ? id : null;
}

export async function authenticateMemberCode(db: D1Database, code: string): Promise<number | null> {
  const { results } = await db
    .prepare(
      `SELECT id, code_hash FROM member_access_codes
       WHERE enabled = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    )
    .all<{ id: number; code_hash: string }>();
  for (const row of results ?? []) {
    if (await verifyMemberCode(code, row.code_hash)) {
      await db
        .prepare("UPDATE member_access_codes SET last_used_at = datetime('now') WHERE id = ?")
        .bind(row.id)
        .run();
      return row.id;
    }
  }
  return null;
}

export async function memberCodeIsActive(db: D1Database, id: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS active FROM member_access_codes
       WHERE id = ? AND enabled = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    )
    .bind(id)
    .first<{ active: number }>();
  return row?.active === 1;
}
