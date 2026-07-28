import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { publicOrigin } from '../features/http/origin';

export const prerender = false;

export const GET: APIRoute = ({ url }) => {
  const origin = publicOrigin(url.origin, env.CANONICAL_ORIGIN);
  const body = `User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/
Sitemap: ${origin}/sitemap.xml
`;
  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
