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
export function validateStamp({ raw, expectedSet, skipBuild = false }) {
  if (raw == null) {
    throw new Error(
      skipBuild
        ? 'dist/ carries no storefront-set stamp. Rebuild (omit --skip-build) so the artifact records which set it contains.'
        : 'The build finished but wrote no storefront-set stamp — the storefront-stamp integration is missing from astro.config.mjs.',
    );
  }
  let stamped;
  try {
    stamped = JSON.parse(raw)?.set;
  } catch {
    throw new Error(
      'dist/storefront-set.json is not valid JSON. Rebuild (omit --skip-build) to regenerate the stamp.',
    );
  }
  if (typeof stamped !== 'string' || stamped.length === 0) {
    throw new Error(
      'dist/storefront-set.json has no "set" string. Rebuild (omit --skip-build) to regenerate the stamp.',
    );
  }
  if (stamped !== expectedSet) {
    throw new Error(
      `dist/ was built for storefront set "${stamped}", but the current selection is "${expectedSet}". ` +
        'Rebuild (omit --skip-build), or change the selection back before deploying.',
    );
  }
  return stamped;
}
