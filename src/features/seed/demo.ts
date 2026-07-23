import type { D1Database } from '@cloudflare/workers-types';
import demoSql from '../../../seed-demo.sql?raw';

/**
 * Optional demo catalog (30 products across 6 categories), offered as a checkbox
 * in the first-run setup wizard. The SQL lives in ./seed-demo.sql (the same file
 * the CLI `db:seed` path uses) and is bundled here as a raw string so the Worker
 * can run it — every insert is `WHERE NOT EXISTS`, so it's safe to re-run.
 */

/** Split the static, comment-annotated seed file into executable statements. */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--')) // drop comment lines
    .join('\n')
    .split(';') // every ';' in seed-demo.sql is a statement terminator
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** True when there are no products yet — so seeding is a first-run-only offer. */
export async function catalogIsEmpty(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM products').first<{ n: number }>();
  return (row?.n ?? 0) === 0;
}

/** Load the demo catalog into D1. Idempotent (guarded inserts); runs in one batch. */
export async function seedDemoCatalog(db: D1Database): Promise<void> {
  const stmts = statements(demoSql);
  if (stmts.length === 0) return;
  await db.batch(stmts.map((s) => db.prepare(s)));
}
