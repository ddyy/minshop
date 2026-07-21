/**
 * Shared response helpers for the public catalog API. CORS is open (it's
 * read-only public data) so browser-based agents/tools can fetch it cross-origin.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
} as const;

/** JSON response with open CORS, pretty-printed for human + agent readability. */
export function catalogJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });
}

/** CORS preflight (OPTIONS). */
export function catalogPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
