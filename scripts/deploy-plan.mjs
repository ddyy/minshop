/**
 * The deploy sequence and its artifact gate, as pure functions.
 *
 * deploy.mjs executes what this module returns and nothing else. That split
 * exists for one reason: the ordering — validate the selection and the built
 * artifact BEFORE touching remote state — is a safety property, and safety
 * properties need regression tests. A test cannot usefully run wrangler, but
 * it can pin the plan and the stamp gate; reordering migrations above
 * validation now fails a unit test instead of silently reintroducing the
 * remote-state hazard.
 */

/** Step names, in execution order, for a given flag combination. */
export function deployPlan({ skipBuild = false, preflightOnly = false } = {}) {
  const steps = [];
  if (!skipBuild) steps.push('build');
  // The two gates run before ANY remote mutation, in every variant.
  steps.push('validate-stamp', 'cache-config');
  if (preflightOnly) return steps;
  steps.push('migrate', 'deploy', 'purge-if-cross-version');
  return steps;
}

/**
 * The artifact gate. `raw` is the stamp file's content, or null when the file
 * does not exist. Throws with an actionable message; returns the stamped id.
 */
export function validateStamp({ raw, expectedTheme, skipBuild = false }) {
  if (raw == null) {
    throw new Error(
      skipBuild
        ? 'dist/ carries no theme stamp. Rebuild (omit --skip-build) so the artifact records which theme it contains.'
        : 'The build finished but wrote no theme stamp — the theme-stamp integration is missing from astro.config.mjs.',
    );
  }
  let stamped;
  try {
    stamped = JSON.parse(raw)?.theme;
  } catch {
    throw new Error(
      'dist/theme.json is not valid JSON. Rebuild (omit --skip-build) to regenerate the stamp.',
    );
  }
  if (typeof stamped !== 'string' || stamped.length === 0) {
    throw new Error(
      'dist/theme.json has no "theme" string. Rebuild (omit --skip-build) to regenerate the stamp.',
    );
  }
  if (stamped !== expectedTheme) {
    throw new Error(
      `dist/ was built for theme "${stamped}", but the current selection is "${expectedTheme}". ` +
        'Rebuild (omit --skip-build), or change the selection back before deploying.',
    );
  }
  return stamped;
}

/**
 * Execute the plan against injected operations. This IS the step→side-effect
 * mapping — deploy.mjs supplies the real operations and adds nothing else, so
 * a test can run this exact function with spies and assert that a failing
 * stamp leaves the migration and deploy operations uncalled. Testing only the
 * plan's step ORDER cannot prove that: a refactor could run the migration
 * inside the validate handler and every string would still be in order.
 *
 * ops: {
 *   expectedTheme          the resolved theme id
 *   readStamp()          stamp file content, or null when absent
 *   build()              compile the artifact
 *   loadCacheConfig()    parse dist config → { crossVersion, origin?, secret? }
 *   migrate()            REMOTE mutation: apply D1 migrations
 *   deploy()             REMOTE mutation: ship the Worker
 *   purge(cacheConfig)   post-deploy cache purge
 * }
 *
 * Throws (rather than exiting) on a failed gate; the caller decides how to
 * report. Steps after a throw never run.
 */
export async function executeDeployPlan({ skipBuild = false, preflightOnly = false } = {}, ops) {
  let cacheConfig;
  const handlers = {
    build: () => ops.build(),
    'validate-stamp': () =>
      validateStamp({ raw: ops.readStamp(), expectedTheme: ops.expectedTheme, skipBuild }),
    'cache-config': () => {
      cacheConfig = ops.loadCacheConfig();
    },
    migrate: () => ops.migrate(),
    deploy: () => ops.deploy(),
    'purge-if-cross-version': async () => {
      if (cacheConfig?.crossVersion) await ops.purge(cacheConfig);
    },
  };
  for (const step of deployPlan({ skipBuild, preflightOnly })) {
    await handlers[step]();
  }
  return { cacheConfig };
}
