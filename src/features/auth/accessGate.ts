export type AccessGateDecision =
  | { action: 'bootstrap' }
  | { action: 'deny'; message: string }
  | { action: 'verify'; token: string; teamDomain: string; aud: string };

/**
 * Decide whether a passwordless admin request may enter bootstrap or must pass
 * Cloudflare Access verification. Defining either Access variable opts the
 * deployment into fail-closed Access mode, including on the workers.dev origin
 * where the edge does not inject an assertion.
 */
export function accessGateDecision(
  token: string | null,
  teamDomain: string | undefined,
  aud: string | undefined,
): AccessGateDecision {
  const accessConfigured = Boolean(teamDomain || aud);

  if (accessConfigured) {
    if (!teamDomain || !aud) {
      return {
        action: 'deny',
        message: 'Cloudflare Access is misconfigured: set both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD.',
      };
    }
    if (!token) {
      return { action: 'deny', message: 'Cloudflare Access authentication required.' };
    }
    return { action: 'verify', token, teamDomain, aud };
  }

  // Never trust an assertion unless this deployment has the issuer + audience
  // needed to verify it. With no assertion and no Access config, first-run
  // password bootstrap remains available.
  if (token) {
    return {
      action: 'deny',
      message: 'Cloudflare Access is not configured: set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD.',
    };
  }
  return { action: 'bootstrap' };
}
