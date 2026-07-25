import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  getProduct,
  getProductImage,
  deleteProductImageRow,
  setProductImageAlt,
  moveProductImage,
  reorderProductImages,
  makeImagePrimary,
  syncPrimaryImage,
} from '../../../../../features/products/db';
import { clearVariantImage } from '../../../../../features/products/variants';
import { validateImage } from '../../../../../features/products/image';
import { optimizeUpload } from '../../../../../features/products/imageOptimize';
import { uploadMedia } from '../../../../../features/media/upload';
import { attachMediaToProduct } from '../../../../../features/media/db';
import { getStorage } from '../../../../../features/storage';

export const prerender = false;

// POST /api/admin/products/:id/images — manage a product's image gallery.
// The PRIMARY image is always the first one (lowest position), so every mutation
// re-syncs products.image_key to the gallery's first image.
//   _action=add      → upload one or more files, append to the gallery
//   _action=reorder  → set the full order from drag-and-drop (fetch; 204)
//   _action=primary  → move image `image_id` to the front (→ becomes primary)
//   _action=move     → swap image `image_id` up/down one slot
//   _action=delete   → remove image `image_id` (object + row)
export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id)) return new Response('Invalid id', { status: 400 });

  const product = await getProduct(env.DB, id);
  if (!product) return new Response('Not found', { status: 404 });

  const back = (msg?: string) =>
    redirect(
      `/admin/products/${id}/edit${msg ? `?error=${encodeURIComponent(msg)}` : ''}#gallery`,
      303,
    );

  const form = await request.formData();
  const action = String(form.get('_action'));
  const storage = getStorage();

  if (action === 'add') {
    const files = form.getAll('images').filter((f): f is File => f instanceof File && f.size > 0);
    for (const file of files) {
      const imgErr = validateImage(file);
      if (imgErr) return back(imgErr);
    }
    for (const file of files) {
      const media = await uploadMedia(env.DB, storage, await optimizeUpload(file), file.name);
      const attached = await attachMediaToProduct(env.DB, id, media.id);
      if (!attached.ok) return back(attached.error);
    }
    await syncPrimaryImage(env.DB, id); // first image stays primary
    return back();
  }

  // Reuse a file already in the library. Same guarded insert as the upload path,
  // so a stale picker selection can't attach media that has since been deleted.
  if (action === 'attach') {
    const mediaId = Number(form.get('media_id'));
    if (!Number.isInteger(mediaId)) return back('Choose an image.');
    const attached = await attachMediaToProduct(env.DB, id, mediaId);
    if (!attached.ok) return back(attached.error);
    await syncPrimaryImage(env.DB, id);
    return back();
  }

  // Bulk reorder from drag-and-drop (fetch). No single image_id; returns 204.
  if (action === 'reorder') {
    const ids = form
      .getAll('order')
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n));
    await reorderProductImages(env.DB, id, ids);
    await syncPrimaryImage(env.DB, id); // new first image becomes primary
    return new Response(null, { status: 204 });
  }

  const imageId = Number(form.get('image_id'));
  const img = Number.isInteger(imageId) ? await getProductImage(env.DB, imageId) : null;
  if (!img || img.product_id !== id) return back('Image not found.');

  if (action === 'alt') {
    await setProductImageAlt(env.DB, imageId, String(form.get('alt') ?? ''));
    return back();
  }

  if (action === 'primary') {
    await makeImagePrimary(env.DB, id, imageId);
    return back();
  }

  if (action === 'move') {
    const dir = form.get('direction') === 'up' ? 'up' : 'down';
    await moveProductImage(env.DB, imageId, dir);
    await syncPrimaryImage(env.DB, id);
    return back();
  }

  if (action === 'delete') {
    // Drops the ASSOCIATION only. The file stays in the media library, where it
    // may still be used by another product, a page, or the logo — and where it
    // is deleted explicitly. Removing an image from one product must never
    // break it somewhere else.
    await deleteProductImageRow(env.DB, imageId);
    await clearVariantImage(env.DB, imageId); // drop dangling variant references
    await syncPrimaryImage(env.DB, id); // promotes the new first image (or null)
    return back();
  }

  return back('Unknown action.');
};
