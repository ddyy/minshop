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

export const onRequest = defineMiddleware(async (context, next) => {
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
