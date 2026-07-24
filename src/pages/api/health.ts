import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

/**
 * GET /api/health — liveness/readiness probe for uptime monitors and load
 * balancers. Runs one trivial D1 query to confirm the database is reachable;
 * everything else the store needs degrades gracefully, so the DB is the one
 * hard dependency worth gating on. 200 = healthy, 503 = the DB check failed.
 * No auth and no sensitive detail in the body (safe to expose publicly).
 */
export const GET: APIRoute = async () => {
  const started = Date.now();
  let db: 'ok' | 'down' = 'ok';
  try {
    await env.DB.prepare('SELECT 1').first();
  } catch {
    db = 'down';
  }
  const healthy = db === 'ok';
  return new Response(
    JSON.stringify({
      status: healthy ? 'ok' : 'error',
      db,
      latency_ms: Date.now() - started,
      time: new Date().toISOString(),
    }),
    {
      status: healthy ? 200 : 503,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
};
