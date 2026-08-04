import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { deployPlan, executeDeployPlan, validateStamp } from '../../scripts/deploy-plan.mjs';

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
  const expectedTheme = 'acme';

  it('rejects a missing stamp, with skip-build-specific guidance', () => {
    expect(() => validateStamp({ raw: null, expectedTheme, skipBuild: true })).toThrow(
      /omit --skip-build/,
    );
    // Without --skip-build a build JUST ran, so a missing stamp means the
    // stamping integration itself is broken — a different failure needing a
    // different message.
    expect(() => validateStamp({ raw: null, expectedTheme, skipBuild: false })).toThrow(
      /integration is missing/,
    );
  });

  it('rejects a malformed stamp', () => {
    expect(() => validateStamp({ raw: 'not json{', expectedTheme })).toThrow(/not valid JSON/);
    expect(() => validateStamp({ raw: '{}', expectedTheme })).toThrow(/no "theme" string/);
    expect(() => validateStamp({ raw: '{"theme":""}', expectedTheme })).toThrow(/no "theme" string/);
  });

  it('rejects a mismatched stamp, naming both sets', () => {
    expect(() => validateStamp({ raw: '{"theme":"studio"}', expectedTheme })).toThrow(
      /built for theme "studio".*selection is "acme"/,
    );
  });

  it('accepts a matching stamp', () => {
    expect(validateStamp({ raw: '{"theme":"acme"}', expectedTheme })).toBe('acme');
  });
});

// Ordering strings alone cannot prove safety: a refactor could run the
// migration inside the validate handler and every string would still be in
// order. These tests execute the REAL step→operation mapping
// (executeDeployPlan — the same function deploy.mjs runs) with spies, and
// assert on what was actually invoked.
describe('executeDeployPlan side effects', () => {
  const spies = (overrides = {}) => ({
    expectedTheme: 'acme',
    readStamp: vi.fn(() => '{"theme":"acme"}'),
    build: vi.fn(),
    loadCacheConfig: vi.fn(() => ({ crossVersion: false })),
    migrate: vi.fn(),
    deploy: vi.fn(),
    purge: vi.fn(),
    ...overrides,
  });

  it.each([
    ['missing', null],
    ['malformed', 'not json{'],
    ['empty-set', '{}'],
    ['mismatched', '{"theme":"studio"}'],
  ])('a %s stamp prevents every remote mutation', async (_label, raw) => {
    const ops = spies({ readStamp: vi.fn(() => raw) });
    await expect(executeDeployPlan({ skipBuild: true }, ops)).rejects.toThrow();
    expect(ops.migrate).not.toHaveBeenCalled();
    expect(ops.deploy).not.toHaveBeenCalled();
    expect(ops.purge).not.toHaveBeenCalled();
  });

  it('a failed build prevents everything after it', async () => {
    const ops = spies({ build: vi.fn(() => { throw new Error('compile error'); }) });
    await expect(executeDeployPlan({}, ops)).rejects.toThrow('compile error');
    expect(ops.readStamp).not.toHaveBeenCalled();
    expect(ops.migrate).not.toHaveBeenCalled();
    expect(ops.deploy).not.toHaveBeenCalled();
  });

  it('a successful deploy runs the operations in the safe order', async () => {
    const order = [];
    const named = (name, fn = () => {}) => vi.fn((...a) => { order.push(name); return fn(...a); });
    const ops = spies({
      readStamp: named('validate', () => '{"theme":"acme"}'),
      build: named('build'),
      loadCacheConfig: named('cache-config', () => ({ crossVersion: false })),
      migrate: named('migrate'),
      deploy: named('deploy'),
      purge: named('purge'),
    });
    await executeDeployPlan({}, ops);
    expect(order).toEqual(['build', 'validate', 'cache-config', 'migrate', 'deploy']);
  });

  it('a preflight invokes no remote mutation even with a valid stamp', async () => {
    const ops = spies();
    await executeDeployPlan({ skipBuild: true, preflightOnly: true }, ops);
    expect(ops.readStamp).toHaveBeenCalled();
    expect(ops.loadCacheConfig).toHaveBeenCalled();
    expect(ops.migrate).not.toHaveBeenCalled();
    expect(ops.deploy).not.toHaveBeenCalled();
    expect(ops.purge).not.toHaveBeenCalled();
  });

  it('purges only under cross-version caching, and after deploy', async () => {
    const order = [];
    const named = (name, fn = () => {}) => vi.fn((...a) => { order.push(name); return fn(...a); });
    const crossVersion = spies({
      loadCacheConfig: () => ({ crossVersion: true, origin: 'https://x', secret: 's' }),
      deploy: named('deploy'),
      purge: named('purge'),
    });
    await executeDeployPlan({ skipBuild: true }, crossVersion);
    expect(order).toEqual(['deploy', 'purge']);

    const plain = spies();
    await executeDeployPlan({ skipBuild: true }, plain);
    expect(plain.purge).not.toHaveBeenCalled();
  });
});

describe('deploy.mjs stays on the executor', () => {
  it('supplies operations to executeDeployPlan and calls wrangler only inside them', () => {
    // The spy tests above prove the mapping; this pins that deploy.mjs
    // actually uses it. Every wrangler invocation must live inside the `ops`
    // object handed to the shared executor — a bare call added elsewhere
    // would bypass the mapping the spies verify.
    const source = readFileSync('scripts/deploy.mjs', 'utf8');
    expect(source).toContain('executeDeployPlan({ skipBuild, preflightOnly }, ops)');
    const opsStart = source.indexOf('const ops = {');
    expect(opsStart).toBeGreaterThan(-1);
    const opsBlock = source.slice(opsStart, source.indexOf('executeDeployPlan(', opsStart));
    const wranglerCalls = source.match(/'wrangler'/g) ?? [];
    const inOps = opsBlock.match(/'wrangler'/g) ?? [];
    expect(wranglerCalls.length).toBeGreaterThan(0);
    expect(wranglerCalls.length).toBe(inOps.length);
  });
});

describe('private deliverable provisioning', () => {
  it('binds a distinct private bucket in both deployment configs', () => {
    const committed = readFileSync('wrangler.jsonc', 'utf8');
    const template = readFileSync('wrangler.template.jsonc', 'utf8');
    expect(committed).toMatch(/"binding"\s*:\s*"FILES"[\s\S]*?"bucket_name"\s*:\s*"minshop-files"/);
    expect(template).toMatch(/"binding"\s*:\s*"FILES"[\s\S]*?"bucket_name"\s*:\s*"__FILES_BUCKET__"/);
    expect(template).toMatch(/never enable r2\.dev or attach a custom domain/i);
  });

  it('records the per-instance bucket and preserves that record if deletion fails', () => {
    const provision = readFileSync('scripts/provision-cf.sh', 'utf8');
    const destroy = readFileSync('scripts/destroy-cf.sh', 'utf8');
    expect(provision).toContain('FILES_BUCKET="${SLUG}-files"');
    expect(provision).toContain('echo "FILES_BUCKET=$FILES_BUCKET"');
    expect(destroy).toContain("recorded_files_bucket=");
    expect(destroy).toContain('if [[ "$files_bucket_deleted" == "1" ]]');
    expect(destroy).toContain('RESIDUAL_RESOURCE=private-files');
    expect(destroy).toContain('CLEANUP_COMMAND=npx wrangler r2 bucket delete $FILES_BUCKET');
  });
});
