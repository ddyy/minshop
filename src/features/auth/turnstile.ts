/**
 * Cloudflare Turnstile server-side verification. minshop is itself a Worker, so we
 * verify the token directly in our own routes (browser → minshop Worker →
 * siteverify) — no separate siteverify Worker. Pure + dependency-free (takes the
 * secret as a param, no `cloudflare:workers` import) so it's unit-testable.
 *
 * Turnstile is OPT-IN, configured in Admin → Settings → Bot protection: a route
 * only enforces it when enabled + the secret is set (and the widget only renders
 * when the sitekey is set). Off = no-op, so a fresh clone works without it.
 *
 * Local dev uses Cloudflare's documented TEST keys (always-pass). Swap for a real
 * widget's sitekey + secret at deploy.
 */
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** The form field Turnstile injects into the surrounding form. */
export const TURNSTILE_FIELD = 'cf-turnstile-response';

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
