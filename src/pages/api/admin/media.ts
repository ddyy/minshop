import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getConfig } from '../../../config';
import {
  listMedia,
  countMedia,
  MEDIA_PAGE_SIZE,
  type Media,
} from '../../../features/media/db';
import { mediaUsageForIds, isUnused } from '../../../features/media/usage';
import { mediaUrl } from '../../../features/media/url';
import { uploadMedia, validateUpload } from '../../../features/media/upload';
import { optimizeUpload } from '../../../features/products/imageOptimize';
import { prewarmImageTransforms } from '../../../features/products/image';
import { getSetting } from '../../../features/settings/db';
import { getStorage } from '../../../features/storage';

export const prerender = false;

/** Clamp caller-supplied paging to the grid's bounds. One parser, both callers. */
export function parseMediaListQuery(params: URLSearchParams): {
  limit: number;
  offset: number;
} {
  const rawLimit = Number(params.get('limit'));
  const rawOffset = Number(params.get('offset'));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MEDIA_PAGE_SIZE)
      : MEDIA_PAGE_SIZE;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}

export interface MediaListItem {
  /** The med_ public ID — admin JSON never carries numeric row ids. */
  id: string | null;
  imageKey: string;
  url: string;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
  inUse: boolean;
}

/**
 * One page of library items plus their usage. Shared by the JSON API and the
 * admin grid so both report identical usage from the same bulk query.
 *
 * Callers pass an already-clamped offset — the admin page counts first so
 * `paginate()` can clamp an out-of-range `?page=` to the last real page rather
 * than rendering an empty grid.
 */
export async function loadMediaPage(limit: number, offset: number) {
  const items = await listMedia(env.DB, limit, offset);
  // One bulk resolve for the whole page — never one usage query per row.
  const usage = await mediaUsageForIds(
    env.DB,
    items.map((m) => m.id),
  );
  return { items, usage, baseUrl: getConfig().images.baseUrl };
}

function serialize(media: Media, inUse: boolean, baseUrl: string): MediaListItem {
  return {
    id: media.public_id,
    imageKey: media.image_key,
    url: mediaUrl(media.image_key, baseUrl),
    originalName: media.original_name,
    mimeType: media.mime_type,
    sizeBytes: media.size_bytes,
    createdAt: media.created_at,
    inUse,
  };
}

// GET /api/admin/media — paginated library JSON for the picker.
export const GET: APIRoute = async ({ url }) => {
  const { limit, offset } = parseMediaListQuery(url.searchParams);
  const total = await countMedia(env.DB);
  const { items, usage, baseUrl } = await loadMediaPage(limit, offset);

  return new Response(
    JSON.stringify({
      media: items.map((m) => {
        const entry = usage.get(m.id);
        return serialize(m, !(entry && isUnused(entry)), baseUrl);
      }),
      total,
      limit,
      offset,
    }),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'private, no-store',
      },
    },
  );
};

// POST /api/admin/media — upload one or more images into the library.
// Answers JSON to the picker (fetch) and redirects for a plain form post.
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const wantsJson = request.headers.get('accept')?.includes('application/json');
  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);

  const fail = (msg: string, status = 400) =>
    wantsJson
      ? new Response(JSON.stringify({ error: msg }), {
          status,
          headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
        })
      : redirect(`/admin/media?error=${encodeURIComponent(msg)}`, 303);

  if (files.length === 0) return fail('Choose at least one image.');

  // Validate everything before storing anything, so a bad file in a multi-select
  // doesn't leave half the batch uploaded.
  for (const file of files) {
    const err = validateUpload(file);
    if (err) return fail(err);
  }

  const uploaded = [];
  const baseUrl = getConfig().images.baseUrl;
  for (const file of files) {
    const media = await uploadMedia(env.DB, getStorage(), await optimizeUpload(file), file.name);
    uploaded.push({
      // med_ public ID — never the row id.
      id: media.public_id,
      imageKey: media.image_key,
      url: mediaUrl(media.image_key, baseUrl),
      originalName: media.original_name,
    });
  }

  // Pre-generate each upload's responsive ladder behind the response, so the
  // first shopper hits warm cache instead of ~2.4s cold AVIF encodes. The
  // delivery-mode read happens inside the background task — middleware doesn't
  // load settings for /api/ routes, and the admin shouldn't wait on it either.
  const ctx = locals.cfContext;
  if (ctx && baseUrl) {
    const transformOrigin = new URL(request.url).origin;
    ctx.waitUntil(
      (async () => {
        if ((await getSetting(env.DB, 'image_delivery')) !== 'cloudflare') return;
        for (const m of uploaded) {
          await prewarmImageTransforms(m.imageKey, baseUrl, transformOrigin);
        }
      })().catch((err) => console.error('Image pre-warm failed:', err)),
    );
  }

  return wantsJson
    ? new Response(JSON.stringify({ media: uploaded }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
      })
    : redirect('/admin/media', 303);
};
