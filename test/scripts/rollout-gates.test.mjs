import { describe, expect, it } from 'vitest';

// Deliberately .mjs, not .ts, for the same reason as test/storefront/boundary.test.mjs:
// tsconfig's `types` is pinned to the Cloudflare types, so node builtins have no
// declarations and a .ts file here fails `astro check`.
import { readFileSync } from 'node:fs';

import {
  DIGITAL_DELIVERY_RELEASE,
  attachmentActive,
  entitlementWriterActive,
  lifecycleActive,
} from '../../src/features/digitalDelivery/rollout.ts';

/**
 * Digital delivery ships as four releases, each a valid rollback target for the
 * next. That is enforced by a compile-time constant, so a build pinned at 4
 * cannot execute release 1's writers — but it CAN pin the property that makes
 * those rollbacks safe: every reader ships ungated, so an older build still
 * understands and serves what a newer one wrote.
 *
 * A gate added to any reader below turns a rollback from quiet into lossy —
 * a published order_status_url starts returning 404 (which the contract defines
 * as "unknown or revoked", i.e. permanent loss), or a paid order records no
 * entitlement at all. Both fail silently, in production only.
 *
 * Cross-release BEHAVIOUR is covered in test/integration/reservations.mjs, which
 * settles snapshots written in a higher release's shape.
 */

const GATE_RE = /lifecycleActive|entitlementWriterActive|attachmentActive/;

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('digital-delivery rollout gates', () => {
  it('advances one release at a time, each threshold one above the last', () => {
    const ladder = source('src/features/digitalDelivery/rollout.ts');
    expect(ladder).toMatch(/lifecycleActive = \(release:[^)]*\) =>\s*release >= 2/);
    expect(ladder).toMatch(/entitlementWriterActive = \(release:[^)]*\) =>\s*release >= 3/);
    expect(ladder).toMatch(/attachmentActive = \(release:[^)]*\) =>\s*release >= 4/);
  });

  it('reports the release this build is pinned to', () => {
    expect(DIGITAL_DELIVERY_RELEASE).toBe(4);
    expect([lifecycleActive(), entitlementWriterActive(), attachmentActive()]).toEqual([
      true,
      true,
      true,
    ]);
  });

  // Release 2 hands out order_status_url; release 4 attaches files. Both roll
  // back to a build that must still read and serve what they produced.
  it.each([
    ['src/features/orders/db.ts', 'settlement preserves an itm_ ID and file_* snapshot'],
    ['src/features/orders/recordWebhook.ts', 'late settlement of a terminal reservation'],
    ['src/features/orders/guestAccess.ts', 'tombstone retention and resolution'],
    ['src/pages/order/[token]/status.ts', 'a published status URL must not 404 after rollback'],
    ['src/pages/order/[token]/download/[itemPublicId].ts', 'entitlements must keep serving'],
  ])('%s stays ungated — %s', (path) => {
    expect(source(path)).not.toMatch(GATE_RE);
  });

  // The writers are the half that IS allowed to be gated; if a gate disappears
  // from one of these, an earlier release stops being dormant.
  //
  // Asserted one SITE at a time, not one file at a time. Several of these files
  // hold multiple independently required gates — reservations.ts gates terminal
  // writes and identity claiming, checkout.ts has two separate response paths,
  // the product route gates upload and removal — so a file-level "contains a
  // gate somewhere" check goes on passing after any single one is removed. That
  // is exactly the case where an earlier release silently stops being dormant.
  const countOf = (haystack, needle) => haystack.split(needle).length - 1;

  it.each([
    // Release 2 — terminal reservation states.
    [
      'src/features/orders/reservations.ts',
      'provider-confirmed terminal state',
      /releaseReservation\(db, publicId, lifecycleActive\(\) \? status : 'released'\)/,
    ],
    // Release 2 — itm_ identity, all three sites of one claim.
    [
      'src/features/orders/reservations.ts',
      'identity generation',
      /publicId: item\.publicId \?\? \(lifecycleActive\(release\) \? generatePublicId\('orderItem'\) : undefined\)/,
    ],
    [
      'src/features/orders/reservations.ts',
      'identity collision preflight',
      /lifecycleActive\(release\) &&\s*\(await hasClaimedItemId/,
    ],
    [
      'src/features/orders/reservations.ts',
      'registry claim statements',
      /const claims = lifecycleActive\(release\) \?/,
    ],
    // Release 2 — both JSON checkout responses.
    [
      'src/pages/api/checkout.ts',
      'order_status_url on the Lightning invoice response',
      /lifecycleActive\(\)\s*\?\s*\{ order_status_url: `\$\{origin\}\/order\/\$\{lnAccessToken\}\/status` \}/,
    ],
    [
      'src/pages/api/checkout.ts',
      'order_status_url on the hosted/redirect response',
      /lifecycleActive\(\) \? \{ order_status_url: `\$\{origin\}\/order\/\$\{accessToken\}\/status` \}/,
    ],
    // Release 3 — the entitlement snapshot.
    [
      'src/features/orders/reservationItems.ts',
      'file_* snapshot',
      /entitlementWriterActive\(\) && line\.product\.file_key/,
    ],
    // Release 4 — attachment, on every route that can write a product file.
    [
      'src/features/products/ProductForm.astro',
      'the upload field itself',
      /\{attachmentActive\(\) && <fieldset/,
    ],
    [
      'src/pages/api/admin/products/[id].ts',
      'deliverable removal',
      /\} else if \(attachmentActive\(\) && form\.get\('remove_deliverable'\)/,
    ],
  ])('%s gates %s', (path, _site, pattern) => {
    expect(source(path)).toMatch(pattern);
  });

  // Sites whose text is identical to a sibling, so only a count distinguishes
  // "both present" from "one silently dropped".
  it.each([
    [
      'src/features/orders/reservations.ts',
      "lifecycleActive() ? 'expired' : 'released'",
      2, // the expiry sweep + the self-rendered status-read expiry
    ],
    [
      'src/pages/api/admin/products.ts',
      'attachmentActive() && deliverable instanceof File',
      2, // validate before the write, then upload after it
    ],
    [
      'src/pages/api/admin/products/[id].ts',
      'attachmentActive() && deliverable instanceof File',
      2, // same pair on the edit route
    ],
  ])('%s keeps all %s gates', (path, needle, expected) => {
    expect(countOf(source(path), needle)).toBe(expected);
  });
});

/**
 * llms.txt advertises the MCP endpoint only when MCP_URL is set. The MCP server
 * is a separate, optional Worker whose hostname the storefront cannot derive, so
 * a default would point agents at something that does not exist.
 */
describe('optional MCP advertisement', () => {
  const llms = source('src/pages/llms.txt.ts');

  it('renders the MCP line only from a configured MCP_URL', () => {
    expect(llms).toMatch(/const mcpUrl = \(env\.MCP_URL \?\? ''\)\.trim\(\)/);
    // Falsy MCP_URL must contribute the empty string, never a placeholder host.
    expect(llms).toMatch(/: '';/);
    expect(llms).not.toMatch(/mcp\.example\.com|your-mcp-host['"`]/);
  });

  it('gates the buyer tier behind a rate limiter keyed on the real client', () => {
    const mcp = source('mcp/src/index.ts');
    // Only this Worker sees the buyer's address; the storefront sees ours.
    expect(mcp).toMatch(/if \(!operator && env\.MCP_RATE_LIMITER\)/);
    expect(mcp).toMatch(/cf-connecting-ip/);
    expect(mcp).toMatch(/key: `mcp:\$\{client\}`/);
  });
});
