import type { APIRoute } from 'astro';
import { getStorage } from '../../features/storage';

export const prerender = false;

const IMMUTABLE = 'public, max-age=31536000, immutable';

// Serves product images from object storage (keys can contain slashes, hence the
// rest param). Keys are unique per upload, so responses are immutable.
//
// Cloudflare does NOT edge-cache Worker responses automatically, so without an
// explicit Cache API pass every request would re-fetch from R2 (the immutable
// header only helps the browser). We check caches.default first and store on a
// miss, so each colo fetches a given image from R2 once and serves the rest from
// the edge. `caches` is absent under `astro dev`, so the whole step is guarded.
export const GET: APIRoute = async ({ params, request, locals }) => {
  const key = params.key;
  if (!key) return new Response('Not found', { status: 404 });

  // Absent under `astro dev`; src/env.d.ts merges Cloudflare's `.default` onto
  // the browser CacheStorage surface used by Astro's DOM types.
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(request);
    if (hit) return hit;
  }

  const obj = await getStorage().get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  const response = new Response(obj.body, {
    headers: {
      'content-type': obj.contentType,
      'cache-control': IMMUTABLE,
    },
  });

  // Store without blocking the response; waitUntil keeps the put alive after we
  // return. Only reachable in the Workers runtime (cache + cfContext both present).
  if (cache && locals.cfContext) {
    locals.cfContext.waitUntil(cache.put(request, response.clone()));
  }
  return response;
};
