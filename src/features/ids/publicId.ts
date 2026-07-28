/**
 * Prefixed public IDs — the external identity for records whose row IDs must
 * never cross an application boundary. Format: `<prefix>_<10 lowercase
 * Crockford base32 chars>` (50 random bits). Pure (no bindings) so it's
 * unit-testable and shared by server routes, DTOs, and the backfill script.
 *
 * Public IDs are identifiers, not credentials — guest order access uses the
 * separate `otk_` access token (see token.ts). Input is normalized to
 * lowercase before strict validation so a hand-typed reference still resolves;
 * storage and output are lowercase only.
 */

/** One entry per externally addressable record type. Prefixes are permanent. */
export const PUBLIC_ID_PREFIXES = {
  product: 'prod',
  variant: 'var',
  extra: 'xtra',
  category: 'cat',
  page: 'page',
  order: 'ord',
  media: 'med',
  productImage: 'pimg',
  navItem: 'nav',
  refund: 'rfnd',
} as const;

export type PublicIdKind = keyof typeof PUBLIC_ID_PREFIXES;

/** Lowercase Crockford base32 — no i, l, o, u. */
export const PUBLIC_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export const PUBLIC_ID_TOKEN_LENGTH = 10;

const TOKEN_RE = /^[0-9abcdefghjkmnpqrstvwxyz]{10}$/;

/** 256 is divisible by 32, so masking a random byte to 5 bits stays uniform. */
export function generatePublicId(kind: PublicIdKind): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PUBLIC_ID_TOKEN_LENGTH));
  let token = '';
  for (const b of bytes) token += PUBLIC_ID_ALPHABET[b & 0x1f];
  return `${PUBLIC_ID_PREFIXES[kind]}_${token}`;
}

/**
 * Normalize + strictly validate a public ID of the expected kind.
 * Returns the canonical lowercase form, or null when the prefix, length, or
 * alphabet is wrong — a variant ID can never pass where a product ID is
 * expected.
 */
export function parsePublicId(value: unknown, kind: PublicIdKind): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  const prefix = `${PUBLIC_ID_PREFIXES[kind]}_`;
  if (!normalized.startsWith(prefix)) return null;
  const token = normalized.slice(prefix.length);
  if (!TOKEN_RE.test(token)) return null;
  return normalized;
}

/** The bare 10-char token — the customer-facing order reference. */
export function publicIdToken(publicId: string, kind: PublicIdKind): string | null {
  const parsed = parsePublicId(publicId, kind);
  return parsed ? parsed.slice(PUBLIC_ID_PREFIXES[kind].length + 1) : null;
}

/**
 * Legacy order/refund public-ID shapes that predate prefixes and are preserved
 * indefinitely: 32-char lowercase hex (migration 0005 backfill) and UUIDv4
 * (crypto.randomUUID creation paths).
 */
const LEGACY_HEX32_RE = /^[0-9a-f]{32}$/;
const LEGACY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isLegacyPublicId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return LEGACY_HEX32_RE.test(v) || LEGACY_UUID_RE.test(v);
}

/** Accepts the new prefixed form or a preserved legacy shape (orders/refunds). */
export function parseOrderOrLegacyPublicId(value: unknown, kind: 'order' | 'refund'): string | null {
  const prefixed = parsePublicId(value, kind);
  if (prefixed) return prefixed;
  if (isLegacyPublicId(value)) return (value as string).trim().toLowerCase();
  return null;
}

/** True when an insert failed on a public_id unique index (retry with a fresh ID). */
export function isPublicIdConflict(err: unknown): boolean {
  return err instanceof Error && /UNIQUE/i.test(err.message) && /public_id|access_token/i.test(err.message);
}

/**
 * Run an insert with a freshly generated public ID, regenerating on a unique
 * conflict. The unique index is the collision authority; at 50 bits a retry is
 * a freak event, so three attempts is generous.
 */
export async function withPublicId<T>(
  kind: PublicIdKind,
  insert: (publicId: string) => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await insert(generatePublicId(kind));
    } catch (err) {
      if (!isPublicIdConflict(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}
