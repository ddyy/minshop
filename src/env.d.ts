/// <reference types="astro/client" />

// Raw .sql imports (Vite `?raw`) — used to run seed files at runtime (see
// src/features/seed/demo.ts). `types` in tsconfig.json overrides the default
// lib set, so declare it explicitly rather than relying on vite/client.
declare module '*.sql?raw' {
  const content: string;
  export default content;
}

// Astro 7 + @astrojs/cloudflare v14: bindings are accessed via
//   import { env } from 'cloudflare:workers'
// and `env` is typed as Cloudflare.Env. Declare the shape here.
// Minimal shape of the Cloudflare Images binding — just what optimizeUpload uses.
interface ImagesBindingMin {
  input(stream: ReadableStream): {
    transform(opts: { width?: number; height?: number }): {
      output(opts: { format: string; quality?: number }): Promise<{ response(): Response }>;
    };
  };
}

// Set by src/middleware.ts after verifying a Cloudflare Access JWT (Layer 2).
declare namespace App {
  interface Locals {
    adminEmail?: string;
    /** Runtime settings overlay (store name etc.), loaded once per request. */
    settings?: import('./features/settings/db').StoreSettings;
  }
}

declare namespace Cloudflare {
  interface Env {
    DB: import('@cloudflare/workers-types').D1Database;
    BUCKET: import('@cloudflare/workers-types').R2Bucket;
    // Native edge counters for anonymous credential and paid-provider abuse.
    // Optional in the type so an older custom config fails open during upgrade;
    // the provisioning template and active project config declare them.
    AUTH_RATE_LIMITER?: import('@cloudflare/workers-types').RateLimit;
    CHECKOUT_RATE_LIMITER?: import('@cloudflare/workers-types').RateLimit;
    // Optional: Cloudflare Images binding for upload optimization (needs
    // Transformations enabled). Absent = uploads stored as-is (imageOptimize.ts
    // guards + falls back), so the free-plan default config omits it.
    IMAGES?: ImagesBindingMin;
    // Semantic search (config.search.provider='vector'). Present only when bound:
    // AI = Workers AI (embeddings); VECTORIZE = the Vectorize index. Both optional
    // so the default FTS path needs neither.
    AI?: import('@cloudflare/workers-types').Ai;
    VECTORIZE?: import('@cloudflare/workers-types').VectorizeIndex;
    // Search backend selector (overrides config.search.provider): 'fts' | 'vector'.
    SEARCH_PROVIDER?: string;
    STORE_NAME: string;
    // Fallback IANA time zone; setup/admin settings store the runtime override.
    TIME_ZONE?: string;
    // Admin auth (src/middleware.ts): the password is set in the first-run setup
    // wizard and stored as a PBKDF2 hash in D1 — there is no ADMIN_PASSWORD env var.
    // Until one is set the wizard is reachable to create it (bootstrap); Cloudflare
    // Access is the recommended production protection.
    // Required together to enable fail-closed Cloudflare Access mode
    // (src/middleware.ts + src/features/auth/access.ts).
    // Non-secret — set both in wrangler.jsonc `vars` to enable forge-proof checks.
    CF_ACCESS_TEAM_DOMAIN?: string; // https://<team>.cloudflareaccess.com
    CF_ACCESS_AUD?: string; // the Access application's Audience (AUD) tag
    // Cloudflare Turnstile (bot protection on admin login + customer sign-in) is configured
    // in Admin → Settings → Bot protection: enabled + sitekey are D1 settings, the
    // secret is in the encrypted vault. No env vars.
    //
    // ALL provider keys (Stripe, OpenNode, Lightning, Resend, Turnstile) and their
    // config (default rail, Lightning backend + node URLs) are set in the admin
    // dashboard now — keys in the encrypted D1 vault, config in D1 settings. There
    // are NO provider env vars; the only Worker secrets are the two below.
    //
    // Customer accounts (config.features.accounts) + admin sessions: signs the
    // magic-link login token + session cookies (HMAC). Set via wrangler secret.
    AUTH_SECRET?: string;
    // Key-encryption key (KEK) for the at-rest payment-key vault in D1
    // (src/features/secrets). REQUIRED to store/use any provider key — without it
    // the vault is dormant and the store runs demo-only. The KEK itself NEVER goes
    // in D1 — set it with `wrangler secret put SECRETS_KEK` (e.g.
    // `openssl rand -base64 32`); provision-cf/-local set it automatically.
    SECRETS_KEK?: string;
    // Cloudflare Email Sending binding — present only when a sender domain is
    // onboarded (Workers paid plan). Optional so getEmailProvider() can no-op.
    // (The Resend API key is NOT an env var — it's set in the admin dashboard and
    // stored in the encrypted D1 vault. See features/secrets/store.ts.)
    EMAIL?: import('./features/email/cloudflare').EmailBinding;
  }
}
