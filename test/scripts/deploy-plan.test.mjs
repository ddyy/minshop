import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { deployPlan, validateStamp } from '../../scripts/deploy-plan.mjs';

// The deploy ordering is a safety property: a failed or mis-selected build
// must leave remote state untouched. deploy.mjs executes exactly what
// deployPlan returns, so pinning the plan here pins the ordering — moving
// migrations above validation fails this suite, not a production database.

describe('deployPlan ordering', () => {
  const variants = [
    { skipBuild: false, preflightOnly: false },
    { skipBuild: true, preflightOnly: false },
    { skipBuild: false, preflightOnly: true },
    { skipBuild: true, preflightOnly: true },
  ];

  it.each(variants)('validates the stamp before any remote mutation (%o)', (flags) => {
    const plan = deployPlan(flags);
    const validate = plan.indexOf('validate-stamp');
    expect(validate).toBeGreaterThan(-1);
    for (const remote of ['migrate', 'deploy']) {
      const index = plan.indexOf(remote);
      if (index !== -1) expect(index).toBeGreaterThan(validate);
    }
  });

  it.each(variants)('never mutates remote state in a preflight (%o)', (flags) => {
    const plan = deployPlan(flags);
    if (flags.preflightOnly) {
      expect(plan).not.toContain('migrate');
      expect(plan).not.toContain('deploy');
    }
  });

  it('builds before validating, unless the build is skipped', () => {
    const withBuild = deployPlan({ skipBuild: false });
    expect(withBuild.indexOf('build')).toBeLessThan(withBuild.indexOf('validate-stamp'));
    expect(deployPlan({ skipBuild: true })).not.toContain('build');
  });

  it('migrates before deploying, and purges last', () => {
    const plan = deployPlan({});
    expect(plan.indexOf('migrate')).toBeLessThan(plan.indexOf('deploy'));
    expect(plan.at(-1)).toBe('purge-if-cross-version');
  });
});

describe('validateStamp', () => {
  const expectedSet = 'acme';

  it('rejects a missing stamp, with skip-build-specific guidance', () => {
    expect(() => validateStamp({ raw: null, expectedSet, skipBuild: true })).toThrow(
      /omit --skip-build/,
    );
    // Without --skip-build a build JUST ran, so a missing stamp means the
    // stamping integration itself is broken — a different failure needing a
    // different message.
    expect(() => validateStamp({ raw: null, expectedSet, skipBuild: false })).toThrow(
      /integration is missing/,
    );
  });

  it('rejects a malformed stamp', () => {
    expect(() => validateStamp({ raw: 'not json{', expectedSet })).toThrow(/not valid JSON/);
    expect(() => validateStamp({ raw: '{}', expectedSet })).toThrow(/no "set" string/);
    expect(() => validateStamp({ raw: '{"set":""}', expectedSet })).toThrow(/no "set" string/);
  });

  it('rejects a mismatched stamp, naming both sets', () => {
    expect(() => validateStamp({ raw: '{"set":"studio"}', expectedSet })).toThrow(
      /built for storefront set "studio".*selection is "acme"/,
    );
  });

  it('accepts a matching stamp', () => {
    expect(validateStamp({ raw: '{"set":"acme"}', expectedSet })).toBe('acme');
  });
});

describe('deploy.mjs stays on the plan', () => {
  it('routes every wrangler invocation through a plan step', () => {
    // The executor may only reach wrangler from inside a handler the plan
    // ordered. A bare run('npx', ['wrangler', ...]) added outside `handlers`
    // would bypass the ordering this suite pins.
    const source = readFileSync('scripts/deploy.mjs', 'utf8');
    expect(source).toContain("for (const step of deployPlan({ skipBuild, preflightOnly }))");
    const handlersBlock = source.slice(source.indexOf('const handlers'), source.indexOf('for (const step'));
    const wranglerCalls = source.match(/'wrangler'/g) ?? [];
    const inHandlers = handlersBlock.match(/'wrangler'/g) ?? [];
    expect(wranglerCalls.length).toBe(inHandlers.length);
  });
});
