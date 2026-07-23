/**
 * Cloudflare Turnstile server-side verification. minshop is itself a Worker, so we
 * verify the token directly in our own routes (browser → minshop Worker →
 * siteverify) — no separate siteverify Worker. Pure + dependency-free (takes the
 * secret as a param, no `cloudflare:workers` import) so it's unit-testable.
 *
 * Turnstile is OPT-IN, configured in Admin → Settings → Bot protection. When the
 * setting is on, verification fails closed if the secret or response is missing.
 * Off = no-op, so a fresh clone works without it.
 *
 * Local dev uses Cloudflare's documented TEST keys (always-pass). Swap for a real
 * widget's sitekey + secret at deploy.
 */
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** The form field Turnstile injects into the surrounding form. */
export const TURNSTILE_FIELD = 'cf-turnstile-response';

/**
 * Apply the configured policy for a protected form. A missing secret must not
 * silently disable protection after an operator has enabled it.
 */
export async function verifyConfiguredTurnstile(
  enabled: boolean,
  token: string | null | undefined,
  secret: string | null,
  remoteIp?: string | null,
): Promise<boolean> {
  if (!enabled) return true;
  if (!secret) return false;
  return verifyTurnstileToken(token, secret, remoteIp);
}

/**
 * Verify a Turnstile token against siteverify. Returns true only on
 * `success: true`. Never throws — any error (network, bad JSON) → false, so a
 * verification failure fails closed.
 */
export async function verifyTurnstileToken(
  token: string | null | undefined,
  secret: string,
  remoteIp?: string | null,
): Promise<boolean> {
  if (!token) return false;
  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token);
  if (remoteIp) body.set('remoteip', remoteIp);
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
