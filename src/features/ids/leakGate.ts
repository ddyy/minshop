import { PUBLIC_ID_PREFIXES, isLegacyPublicId, type PublicIdKind } from './publicId';

/**
 * Leak gate — recursive inspection of boundary payloads (public JSON, MCP
 * results, rendered form values) enforcing the public-ID invariants:
 *
 *   - no numeric record id: any integer under a key named `id` or `*_id`;
 *   - every prefixed-ID-shaped string carries a registered prefix and, where
 *     the key implies a type (product_id, variant_id, …), the RIGHT prefix;
 *   - no access token (otk_…) anywhere — tokens live only in the few
 *     allowlisted capability-URL positions, which callers exclude explicitly.
 *
 * Deliberately NOT a repository-wide ban on `id`: internal database code keeps
 * integers, and Wrangler legitimately requires `database_id`. This gate runs
 * against serialized boundary output only.
 */

export interface Leak {
  path: string;
  value: unknown;
  reason: string;
}

const PREFIXES = new Set(Object.values(PUBLIC_ID_PREFIXES));

/** Keys whose value must be a public ID of a specific kind (or legacy shape). */
const KEY_KINDS: Record<string, PublicIdKind> = {
  item_public_id: 'orderItem',
  product_id: 'product',
  variant_id: 'variant',
  extra_id: 'extra',
  category_id: 'category',
  page_id: 'page',
  order_id: 'order',
  media_id: 'media',
  refund_id: 'refund',
};

const ID_KEY_RE = /(^id$|_id$)/;
const PREFIXED_RE = /^([a-z]+)_[0-9abcdefghjkmnpqrstvwxyz]{10}$/;
const TOKEN_RE = /otk_[A-Za-z0-9_-]{22}/;

/** Recursively inspect a JSON-serializable value; returns every violation. */
export function findLeaks(value: unknown, path = '$'): Leak[] {
  const leaks: Leak[] = [];
  const walk = (v: unknown, p: string, key: string | null) => {
    if (typeof v === 'number' && key != null && ID_KEY_RE.test(key)) {
      leaks.push({ path: p, value: v, reason: 'numeric record id at an id-named key' });
      return;
    }
    if (typeof v === 'string') {
      // A stringified row id ("42") is the same leak as the number 42.
      if (key != null && ID_KEY_RE.test(key) && /^\d+$/.test(v)) {
        leaks.push({ path: p, value: v, reason: 'numeric-string record id at an id-named key' });
        return;
      }
      if (TOKEN_RE.test(v)) {
        leaks.push({ path: p, value: 'otk_REDACTED', reason: 'access token outside an allowlisted position' });
      }
      const m = PREFIXED_RE.exec(v);
      if (m && !PREFIXES.has(m[1] as never) && key != null && ID_KEY_RE.test(key)) {
        leaks.push({ path: p, value: v, reason: `unregistered public-id prefix "${m[1]}_"` });
      }
      const wantKind = key ? KEY_KINDS[key] : undefined;
      if (wantKind && v !== '' && !v.startsWith(`${PUBLIC_ID_PREFIXES[wantKind]}_`)) {
        const legacyOk = (wantKind === 'order' || wantKind === 'refund') && isLegacyPublicId(v);
        if (!legacyOk) {
          leaks.push({ path: p, value: v, reason: `expected a ${PUBLIC_ID_PREFIXES[wantKind]}_ public ID` });
        }
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`, key));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`, k);
    }
  };
  walk(value, path, null);
  return leaks;
}

/**
 * Inspect rendered HTML: numeric ids in form values / hrefs / query params
 * that address records, and stray access tokens. Heuristic by design — it
 * catches `value="42"` on id-named inputs and `/admin/orders/123`-style paths.
 */
export function findHtmlLeaks(html: string): Leak[] {
  const leaks: Leak[] = [];
  if (TOKEN_RE.test(html)) {
    leaks.push({ path: 'html', value: 'otk_REDACTED', reason: 'access token in markup' });
  }
  // Matches name="id", any name ending in "_id", and name="extra" — the exact
  // field names record forms use (navigation forms post a bare name="id").
  const inputRe = /name="((?:[a-z][a-z_]*_)?id|extra)"[^>]*value="(\d+)"/gi;
  for (const m of html.matchAll(inputRe)) {
    leaks.push({ path: `input[name=${m[1]}]`, value: m[2], reason: 'numeric id in form value' });
  }
  const hrefRe = /(?:href|action)="[^"]*\/(?:admin\/(?:products|orders|categories|pages)|products|categories)\/(\d+)(?:[/?"]|$)/g;
  for (const m of html.matchAll(hrefRe)) {
    leaks.push({ path: 'href', value: m[1], reason: 'numeric id in a record URL' });
  }
  return leaks;
}
