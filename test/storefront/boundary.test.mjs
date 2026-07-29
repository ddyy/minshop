import { describe, expect, it } from 'vitest';

// Deliberately .mjs, not .ts: this is the one storefront test that spawns a
// process, and `tsconfig.compilerOptions.types` is pinned to the Cloudflare
// types so node builtins have no declarations. A .mjs test keeps the check
// without adding @types/node purely to describe `execFile`.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function check(...paths) {
  try {
    const { stdout } = await run('node', ['scripts/check-storefront.mjs', ...paths]);
    return { ok: true, output: stdout };
  } catch (error) {
    const failure = error;
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

// A guardrail nobody has seen fail is indistinguishable from one that does
// nothing. These fixtures exist only to make it fail on purpose.
describe('storefront boundary check', () => {
  it('passes the real storefront, controls, and fixtures', async () => {
    const result = await check();
    expect(result.output).toContain('storefront boundary: ok');
    expect(result.ok).toBe(true);
  });

  it('rejects a template that imports outside the allowlist', async () => {
    const result = await check('test/storefront/violations/template');

    expect(result.ok).toBe(false);
    expect(result.output).toContain('BadImport.astro');
    expect(result.output).toContain('src/config');
  });

  it('rejects a template that reads request context', async () => {
    const result = await check('test/storefront/violations/template');

    expect(result.ok).toBe(false);
    expect(result.output).toContain('BadContext.astro');
    expect(result.output).toContain('Astro.locals');
  });

  it('rejects a control that reaches bindings or D1', async () => {
    const result = await check('test/storefront/violations/controls');

    expect(result.ok).toBe(false);
    expect(result.output).toContain('cloudflare:workers');
    expect(result.output).toContain('a D1 query module');
  });

  it('allows a control to use a pure helper', async () => {
    // The whole point of the second policy: controls encapsulate core behavior,
    // so queryHref is fine where a binding is not. If this ever starts failing,
    // the two policies have been collapsed into one.
    const result = await check('test/storefront/violations/controls');

    expect(result.output).not.toContain('OkControl.astro');
  });
});
