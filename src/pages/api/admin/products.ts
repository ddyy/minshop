import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  createProduct,
  deleteProduct,
  getProduct,
  syncPrimaryImage,
} from '../../../features/products/db';
import { setProductCategories } from '../../../features/categories/db';
import { indexProduct } from '../../../features/search';
import { parseProductForm } from '../../../features/products/form';
import { uniqueSlug } from '../../../features/products/slug';
import { validateImage } from '../../../features/products/image';
import { optimizeUpload } from '../../../features/products/imageOptimize';
import { uploadMedia } from '../../../features/media/upload';
import { attachMediaToProduct } from '../../../features/media/db';
import { getStorage } from '../../../features/storage';

export const prerender = false;

const fail = (msg: string) => `/admin/products/new?error=${encodeURIComponent(msg)}`;

// POST /api/admin/products — create a product (with optional image), then redirect.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const parsed = parseProductForm(form);
  if ('error' in parsed) return redirect(fail(parsed.error), 303);

  let mediaId: number | null = null;
  const file = form.get('image');
  if (file instanceof File && file.size > 0) {
    const imgErr = validateImage(file);
    if (imgErr) return redirect(fail(imgErr), 303);
    // Every upload becomes a library item, whichever screen it came from.
    const media = await uploadMedia(env.DB, getStorage(), await optimizeUpload(file), file.name);
    mediaId = media.id;
  }

  // Slug from the optional slug field, else the name; made unique.
  const slugBase = String(form.get('slug') ?? '').trim() || parsed.data.name;
  const slug = await uniqueSlug(env.DB, slugBase);

  // image_key starts null and is derived from the gallery by syncPrimaryImage.
  // Writing the uploaded key here directly would be an UNGUARDED reference: the
  // media row is unreferenced until the attach lands, so a concurrent library
  // delete could leave the product pointing at an object that no longer exists.
  const productId = await createProduct(env.DB, { ...parsed.data, image_key: null, slug });
  if (mediaId !== null) {
    const attached = await attachMediaToProduct(env.DB, productId, mediaId);
    if (!attached.ok) {
      // The claim needs a product id, so the row has to exist first. Undo it
      // rather than reporting a failure while leaving a half-made product
      // behind for the merchant to trip over on the next attempt.
      await deleteProduct(env.DB, productId);
      return redirect(fail(attached.error), 303);
    }
    await syncPrimaryImage(env.DB, productId); // promotes it to products.image_key
  }

  const categoryIds = form
    .getAll('category')
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (categoryIds.length > 0) await setProductCategories(env.DB, productId, categoryIds);

  // Keep the semantic-search index in sync (no-op unless vector search is on).
  // Never let an indexing hiccup block the create.
  try {
    const created = await getProduct(env.DB, productId);
    if (created) await indexProduct(created);
  } catch (err) {
    console.error('Search index (create) failed:', err);
  }

  return redirect('/admin/products', 303);
};
