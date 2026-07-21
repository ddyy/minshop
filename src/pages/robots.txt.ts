import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = ({ url }) => {
  const body = `User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/
Sitemap: ${url.origin}/sitemap.xml
`;
  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
