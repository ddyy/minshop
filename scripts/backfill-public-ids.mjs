// Backfill prefixed public IDs for rows that predate migration 0033.
//
// Runs OUTSIDE a Worker on purpose: the values must come from the production
// Web Crypto generator (src/features/ids/publicId.ts), which a SQL-only
// migration cannot call. A standalone script has no Worker binding, so all
// reads/writes go through `npx wrangler d1 execute DB` as a child process —
// the repository's established transport — never the raw Cloudflare API.
//
//   node --experimental-strip-types scripts/backfill-public-ids.mjs --local
//   node --experimental-strip-types scripts/backfill-public-ids.mjs --remote
//   node --experimental-strip-types scripts/backfill-public-ids.mjs --local --check
//
// Behavior:
//   - fills ONLY NULL public_id columns; never touches an existing value
//     (legacy order/refund UUID + hex32 shapes are preserved forever);
//   - keyset-paginated batches, resumable and idempotent (guarded UPDATEs);
//   - unique indexes are the collision authority — a failed batch is retried
//     with freshly generated IDs;
//   - populates order_reference_aliases for LEGACY-shaped orders only, using
//     the real orderNumber() code and the effective pre-cutover config;
//   - --check is read-only verification; exits nonzero on any missing,
//     malformed, or duplicate ID or alias.

import { execFileSync } from 'node:child_process';
import {
  generatePublicId,
  parsePublicId,
  isLegacyPublicId,
} from '../src/features/ids/publicId.ts';
import { orderNumber } from '../src/features/orders/number.ts';
import { storeOverrides } from '../src/store.config.ts';

const args = process.argv.slice(2);
const remote = args.includes('--remote');
const local = args.includes('--local');
const checkOnly = args.includes('--check');
if (remote === local) {
  console.error('usage: backfill-public-ids.mjs (--local | --remote) [--check]');
  process.exit(2);
}
const mode = remote ? '--remote' : '--local';
const BATCH = 200;

// Effective order-number config: config.ts defaults + store.config.ts override.
// (config.ts itself imports cloudflare:workers, so the default is mirrored
// here; orderNumber config has never depended on env.)
const orderNumberCfg = {
  offset: 1000,
  step: 1,
  randomStep: 0,
  ...(storeOverrides.orderNumber ?? {}),
};

/** [table, kind] for every covered table whose rows may predate 0033. */
const TABLES = [
  ['products', 'product'],
  ['product_variants', 'variant'],
  ['product_extras', 'extra'],
  ['categories', 'category'],
  ['pages', 'page'],
  ['media', 'media'],
  ['product_images', 'productImage'],
  ['menu_items', 'navItem'],
  ['orders', 'order'],
  ['refunds', 'refund'],
  ['order_items', 'orderItem'],
];

function d1(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'DB', mode, '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out);
  // wrangler --json returns an array of result sets, one per statement.
  return parsed;
}

const rows = (result) => result?.[0]?.results ?? [];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function backfillTable(table, kind) {
  let lastId = 0;
  let filled = 0;
  for (;;) {
    const pending = rows(
      d1(`SELECT id FROM ${table} WHERE public_id IS NULL AND id > ${lastId} ORDER BY id LIMIT ${BATCH}`),
    );
    if (pending.length === 0) break;

    for (let attempt = 0; ; attempt++) {
      const updates = pending
        .map((r) => `UPDATE ${table} SET public_id = ${q(generatePublicId(kind))} WHERE id = ${r.id} AND public_id IS NULL;`)
        .join('\n');
      try {
        d1(updates);
        break;
      } catch (err) {
        if (attempt >= 2) throw err;
        console.error(`  ${table}: batch conflict, retrying with fresh IDs`);
      }
    }
    filled += pending.length;
    lastId = pending[pending.length - 1].id;
  }
  console.log(`${table}: filled ${filled}`);
}

function backfillAliases() {
  // Legacy shape = anything not ord_-prefixed. New ord_ orders created between
  // the first deployment and this run must NOT get aliases.
  let lastId = 0;
  let added = 0;
  for (;;) {
    const legacy = rows(
      d1(
        `SELECT o.id, o.public_id FROM orders o
          WHERE o.public_id NOT LIKE 'ord\\_%' ESCAPE '\\'
            AND o.id > ${lastId}
            AND NOT EXISTS (SELECT 1 FROM order_reference_aliases a WHERE a.order_public_id = o.public_id)
          ORDER BY o.id LIMIT ${BATCH}`,
      ),
    );
    if (legacy.length === 0) break;
    const inserts = legacy
      .map((r) => {
        const ref = String(orderNumber(r.id, orderNumberCfg));
        return `INSERT OR IGNORE INTO order_reference_aliases (reference, order_public_id) VALUES (${q(ref)}, ${q(r.public_id)});`;
      })
      .join('\n');
    d1(inserts);
    added += legacy.length;
    lastId = legacy[legacy.length - 1].id;
  }
  console.log(`order_reference_aliases: added ${added}`);
}

function check() {
  let failed = false;
  for (const [table, kind] of TABLES) {
    const isOrderish = table === 'orders' || table === 'refunds';
    // Validate with the PRODUCTION validators, not a SQL approximation —
    // keyset-paginated so the check stays bounded like the backfill itself.
    let bad = 0;
    let total = 0;
    let lastId = 0;
    for (;;) {
      const page = rows(
        d1(`SELECT id, public_id FROM ${table} WHERE id > ${lastId} ORDER BY id LIMIT ${BATCH}`),
      );
      if (page.length === 0) break;
      for (const r of page) {
        const valid =
          parsePublicId(r.public_id, kind) !== null ||
          (isOrderish && isLegacyPublicId(r.public_id));
        if (!valid) bad++;
      }
      total += page.length;
      lastId = page[page.length - 1].id;
    }
    // Duplicates via a SQL aggregate — a bounded result, not a whole-table read.
    const dupes = rows(
      d1(
        `SELECT COUNT(*) AS n FROM (SELECT public_id FROM ${table}
           WHERE public_id IS NOT NULL GROUP BY public_id HAVING COUNT(*) > 1)`,
      ),
    )[0]?.n ?? 0;
    if (bad > 0 || dupes > 0) {
      console.error(`FAIL ${table}: ${bad} null/malformed, ${dupes} duplicated`);
      failed = true;
    } else {
      console.log(`ok ${table} (${total} rows)`);
    }
  }
  // Every legacy-shaped order has exactly one alias; every alias resolves.
  const missingAlias = rows(
    d1(
      `SELECT COUNT(*) AS n FROM orders o
        WHERE o.public_id NOT LIKE 'ord\\_%' ESCAPE '\\'
          AND NOT EXISTS (SELECT 1 FROM order_reference_aliases a WHERE a.order_public_id = o.public_id)`,
    ),
  )[0]?.n;
  const orphanAlias = rows(
    d1(
      `SELECT COUNT(*) AS n FROM order_reference_aliases a
        WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.public_id = a.order_public_id)`,
    ),
  )[0]?.n;
  if (missingAlias > 0 || orphanAlias > 0) {
    console.error(`FAIL aliases: ${missingAlias} legacy orders without alias, ${orphanAlias} orphaned`);
    failed = true;
  } else {
    console.log('ok order_reference_aliases');
  }
  const missingItemClaim = rows(
    d1(
      `SELECT COUNT(*) AS n FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN order_item_ids i ON i.public_id = oi.public_id
       WHERE oi.public_id IS NULL OR i.public_id IS NULL OR i.order_public_id <> o.public_id`,
    ),
  )[0]?.n ?? 0;
  // Claims without an order_items row are valid while checkout is reserved.
  if (missingItemClaim > 0) {
    console.error(`FAIL order_item_ids: ${missingItemClaim} missing/mismatched`);
    failed = true;
  } else {
    console.log('ok order_item_ids');
  }
  if (failed) process.exit(1);
}

if (checkOnly) {
  check();
} else {
  for (const [table, kind] of TABLES) await backfillTable(table, kind);
  backfillAliases();
  check();
}
