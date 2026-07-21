import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { verifyAccessJwt } from './features/auth/access';
import { accessGateDecision } from './features/auth/accessGate';
import { verifySession } from './features/auth/session';
import { adminCredential } from './features/auth/admin';
import { getStoreSettings } from './features/settings/db';
import {
  checkRateLimit,
  rateLimitBucket,
  rateLimitedResponse,
} from './features/auth/rateLimit';

/**
 * Admin auth gate. Protects BOTH the admin UI (`/admin/*`) and the admin API
 * (`/api/admin/*`) — the API is a separate path, so gating only `/admin` would
 * leave the mutation endpoints open.
 *
 * Precedence:
 *   1. Local dev (`astro dev`) → always allowed (no Access in front of localhost).
 *   2. Admin password set in D1 (via the setup wizard) → form login at
 *      `/admin/login` (password + optional Turnstile) that issues a signed session
 *      cookie; protected requests without a valid cookie are redirected to the
 *      login form (APIs get 401).
 *   3. Cloudflare Access assertion present → ALWAYS verify the JWT signature
 *      against the team JWKS (forge-proof, even against direct *.workers.dev
 *      hits). Access mode REQUIRES CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD; without
 *      both, an assertion is rejected (403) rather than trusted — a bare header is
 *      forgeable at the public origin, so trust-on-presence is a bypass.
 *   4. BOOTSTRAP (first run): no password yet and no Access → the setup wizard
 *      (`/admin/setup`) is OPEN so the operator can create the password; the rest
 *      of /admin bounces there. The wizard auto-logs-you-in on save, which trips
 *      step 2 and closes the window. Set the password promptly, or front /admin
 *      with Access, on a public deploy.
 *
 * Cloudflare Access is the recommended production protection (edge SSO/MFA); the
 * wizard-set password is the built-in alternative. See README → Admin auth. JWT
 * verification lives in features/auth/access.ts; session signing in
 * features/auth/session.ts.
 */
function isProtected(pathname: string): boolean {
  return (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname === '/api/admin' ||
    pathname.startsWith('/api/admin/')
  );
}

// Placeholder values shipped in .dev.vars.example. If a real environment still
// has these, the encryption KEK and session signing key are public knowledge, so
// we fail CLOSED — block every route with fix instructions rather than run with a
// predictable key. Keep these in sync with .dev.vars.example.
const PLACEHOLDER_KEK = 'replace_with_a_long_random_string';
const PLACEHOLDER_AUTH = 'replace_with_a_different_long_random_string';

/** Secret vars still set to their .dev.vars.example placeholder (empty = fine). */
function defaultedSecrets(): string[] {
  const bad: string[] = [];
  if (env.SECRETS_KEK === PLACEHOLDER_KEK) bad.push('SECRETS_KEK');
  if (env.AUTH_SECRET === PLACEHOLDER_AUTH) bad.push('AUTH_SECRET');
  return bad;
}

/** Full-stop error (HTML for pages, text for APIs/assets) telling the operator how to fix. */
function placeholderSecretResponse(vars: string[], apiOrAsset: boolean): Response {
  const gen = 'openssl rand -base64 32';
  const local = vars.map((v) => `${v}=<paste-generated-value>`).join('\n');
  const prod = vars.map((v) => `wrangler secret put ${v}`).join('\n');
  if (apiOrAsset) {
    const body =
      `Store misconfigured: ${vars.join(', ')} still set to the .dev.vars.example placeholder.\n\n` +
      `Generate a strong random value for each (they must differ):\n  ${gen}\n\n` +
      `Local dev — add to .dev.vars (gitignored):\n  ${local.replace(/\n/g, '\n  ')}\n\n` +
      `Production — set each as a Worker secret:\n  ${prod.replace(/\n/g, '\n  ')}\n\n` +
      `Then restart the dev server / redeploy.\n`;
    return new Response(body, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Store misconfigured</title>
<style>body{font:16px/1.6 system-ui,-apple-system,sans-serif;max-width:44rem;margin:4rem auto;padding:0 1.25rem;color:#18181b}
h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:1.75rem}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:#f4f4f5;padding:.9rem 1rem;border-radius:8px;overflow-x:auto;font-size:.9rem}
.vars code{background:#fee2e2;padding:.1rem .4rem;border-radius:4px;margin-right:.35rem}
.muted{color:#71717a;font-size:.9rem}</style></head><body>
<h1>⚠ Store misconfigured — placeholder secrets</h1>
<p>These Worker secrets are still set to the example placeholder from <code>.dev.vars.example</code>:</p>
<p class="vars">${vars.map((v) => `<code>${v}</code>`).join('')}</p>
<p>Running with them makes your encryption key and session signing key public. Every route is blocked until real values are set.</p>
<h2>Fix</h2>
<p>1. Generate a strong random value for <strong>each</strong> (they must be different):</p>
<pre>${gen}</pre>
<p>2. Local dev — add to <code>.dev.vars</code> (gitignored):</p>
<pre>${local.replace(/</g, '&lt;')}</pre>
<p>3. Production — set as Worker secrets:</p>
<pre>${prod}</pre>
<p class="muted">Then restart the dev server (or redeploy) and reload.</p>
</body></html>`;
  return new Response(html, { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export const onRequest = defineMiddleware(async (context, next) => {
  // Fail closed if secrets are still the shipped placeholders — before any other
  // work, so no route (page, API, or asset) serves under a public key.
  const defaulted = defaultedSecrets();
  if (defaulted.length > 0) {
    const p = context.url.pathname;
    return placeholderSecretResponse(defaulted, p.startsWith('/api/') || p.startsWith('/_'));
  }

  // Runtime settings overlay (store name etc.) — only for HTML page requests, so
  // the storefront/admin can reflect wizard-set values without a redeploy. APIs and
  // static assets skip it (one indexed D1 read per page, not per asset/API call).
  const path = context.url.pathname;
  if (!path.startsWith('/api/') && !path.startsWith('/_')) {
    try {
      context.locals.settings = await getStoreSettings(env.DB);
    } catch {
      // Settings table missing (pre-migration) → just use build-time defaults.
    }
  }

  // First-run funnel: until the setup wizard is finished, send the STOREFRONT to it
  // too — the admin already redirects /admin → /admin/setup the same way. Skips
  // /admin (its own gate), /api, and assets to avoid loops; only fires once settings
  // loaded and setup_complete isn't set.
  if (
    !path.startsWith('/admin') &&
    !path.startsWith('/api/') &&
    !path.startsWith('/_') &&
    context.locals.settings &&
    !context.locals.settings.setupComplete
  ) {
    return context.redirect('/admin/setup', 302);
  }

  // Throttle only anonymous, resource-spending mutations. Webhooks are excluded:
  // providers retry them and their signatures are verified by each adapter.
  const bucket = rateLimitBucket(context.request.method, path);
  if (bucket) {
    const limiter = bucket === 'auth' ? env.AUTH_RATE_LIMITER : env.CHECKOUT_RATE_LIMITER;
    try {
      if (!(await checkRateLimit(limiter, context.request, path))) {
        console.warn(JSON.stringify({ event: 'rate_limited', bucket, path }));
        return rateLimitedResponse(path);
      }
    } catch (error) {
      // A limiter outage must not make checkout or login unavailable. Binding
      // failures remain visible in Workers Logs for operational follow-up.
      console.error(
        JSON.stringify({
          event: 'rate_limit_error',
          bucket,
          path,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  if (!isProtected(context.url.pathname)) return next();

  // 1. Localhost dev has no Access edge — don't lock yourself out.
  if (import.meta.env.DEV) return next();

  // 2. Steady state: an admin password is set (via the setup wizard) → require a
  //    valid signed session. Checked before the Access header so it can't be
  //    bypassed by forging it.
  const cred = await adminCredential(env.DB);
  if (cred.enabled) {
    // The login page itself must be reachable unauthenticated (to log in).
    if (path === '/admin/login') return next();
    const session = context.cookies.get('admin_session')?.value ?? null;
    // Sign/verify with AUTH_SECRET (high-entropy key); the credential is the bound tag.
    const signingKey = env.AUTH_SECRET || cred.tagSource;
    if (await verifySession(session, signingKey, cred.tagSource, Date.now() / 1000)) return next();
    // Not authenticated: humans go to the login form, API callers get 401.
    if (path.startsWith('/api/')) {
      return new Response('Authentication required.', { status: 401 });
    }
    return context.redirect('/admin/login', 303);
  }

  // 3. Cloudflare Access. The edge injects a signed JWT into the origin request.
  //    We ALWAYS verify its signature (against the team JWKS) — the header is
  //    otherwise trivially forgeable against the public *.workers.dev origin,
  //    which bypasses the edge Access app bound to your custom hostname. So
  //    Access mode REQUIRES CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD; without both we
  //    fail closed rather than trust an unverifiable header.
  const access = accessGateDecision(
    context.request.headers.get('Cf-Access-Jwt-Assertion'),
    env.CF_ACCESS_TEAM_DOMAIN,
    env.CF_ACCESS_AUD,
  );
  if (access.action === 'deny') {
    return new Response(access.message, { status: 403 });
  }
  if (access.action === 'verify') {
    let identity = null;
    try {
      identity = await verifyAccessJwt(access.token, {
        teamDomain: access.teamDomain,
        aud: access.aud,
      });
    } catch {
      identity = null; // JWKS unreachable etc. → fail closed
    }
    if (identity) {
      context.locals.adminEmail = identity.email;
      return next();
    }
    return new Response('Invalid Access token.', { status: 403 });
  }

  // 4. Bootstrap (first run): no admin password and no Access configuration. The
  //    setup wizard is open so the operator can create the password — which trips
  //    step 2 and locks the door. Everything else under /admin bounces to setup;
  //    admin APIs get 401. (Set the password promptly, or front /admin with
  //    Cloudflare Access, to close this window. See README → Admin auth.)
  if (path === '/admin/setup') return next();
  if (path.startsWith('/api/')) {
    return new Response('Admin not set up yet — complete /admin/setup first.', { status: 401 });
  }
  return context.redirect('/admin/setup', 303);
});
