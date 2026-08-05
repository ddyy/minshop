import { describe, expect, it } from 'vitest';

// .mjs for the same reason as the sibling script tests: tsconfig's `types` is
// pinned to the Cloudflare types, so node builtins have no declarations here.
import { readdirSync, readFileSync } from 'node:fs';

/**
 * `wrangler d1 migrations apply --remote` splits a migration file itself before
 * handing statements to the D1 HTTP API, and it finds a trigger's terminus by
 * scanning for `END;`. A trigger body containing its own `END;` — from a
 * `CASE WHEN … END`, or a nested `BEGIN … END` — is therefore cut short, and D1
 * rejects the remainder with "incomplete input: SQLITE_ERROR".
 *
 * Nothing local catches this: `--local` applies the file verbatim, and even
 * `wrangler d1 execute --remote --file` parses it correctly. Only the remote
 * migrations path fails, which means the first time you find out is against a
 * production database. Reproduced on wrangler 4.115.0 and 4.118.0.
 *
 * Use `SELECT RAISE(ABORT, '…') WHERE EXISTS (…);` instead of
 * `SELECT CASE WHEN EXISTS (…) THEN RAISE(ABORT, '…') END;`.
 */

const MIGRATIONS = new URL('../../migrations/', import.meta.url);

describe('migrations survive wrangler --remote', () => {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'));

  it('has migrations to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // Comments are NOT stripped before matching, deliberately: wrangler's splitter
  // does not strip them either, so a comment inside a trigger body that merely
  // mentions the close keyword truncates the trigger just as effectively as real
  // SQL would. An earlier draft of this test stripped comments and therefore
  // passed a migration that failed against the live database.
  it.each(files)('%s has no early trigger close, in SQL or comments', (name) => {
    const sql = readFileSync(new URL(name, MIGRATIONS), 'utf8');
    const triggers = sql.match(/CREATE TRIGGER[\s\S]*?\nEND;/gi) ?? [];
    for (const trigger of triggers) {
      // The body is everything between the opening BEGIN and the final END;.
      const body = trigger.replace(/^[\s\S]*?\bBEGIN\b/i, '').replace(/\nEND;$/i, '');
      expect(
        body,
        `${name}: a trigger body closes early — wrangler's remote migration ` +
          'splitter truncates there. Use SELECT RAISE(ABORT, …) WHERE EXISTS (…) ' +
          'instead of CASE, and keep explanatory comments outside the body.',
      ).not.toMatch(/\bEND\s*;/i);
    }
  });
});
