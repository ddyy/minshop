import type { APIRoute } from 'astro';
import { getStorage } from '../../features/storage';

export const prerender = false;

// Serves product images from object storage (keys can contain slashes, hence
// the rest param). Immutable cache: keys are unique per upload.
export const GET: APIRoute = async ({ params }) => {
  const key = params.key;
  if (!key) return new Response('Not found', { status: 404 });

  const obj = await getStorage().get(key);
  if (!obj) return new Response('Not found', { status: 404 });

  return new Response(obj.body, {
    headers: {
      'content-type': obj.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
