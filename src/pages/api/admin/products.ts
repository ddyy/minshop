import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  createProduct,
  deleteProduct,
  getProduct,
  syncPrimaryImage,
  setProductFile,
} from '../../../features/products/db';
import { setProductCategories, getCategoriesByPublicIds } from '../../../features/categories/db';
import { parsePublicId } from '../../../features/ids/publicId';
import { indexProduct } from '../../../features/search';
import { parseProductForm } from '../../../features/products/form';
import { zonesRequireWeight } from '../../../features/shipping/calculator';
import { shippingFor } from '../../../features/shipping/effective';
import { uniqueSlug } from '../../../features/products/slug';
import { validateImage } from '../../../features/products/image';
import { optimizeUpload } from '../../../features/products/imageOptimize';
import { uploadMedia } from '../../../features/media/upload';
import { attachMediaToProduct } from '../../../features/media/db';
import { getStorage, getFileStorage } from '../../../features/storage';
import { uploadDigitalFile, validateDigitalFile } from '../../../features/products/digitalFile.ts';
import { attachmentActive } from '../../../features/digitalDelivery/rollout.ts';
import { CACHE_TAG } from '../../../features/cache/tags';
import { purgeCacheTags } from '../../../features/cache/purge';

export const prerender = false;

const fail = (msg: string) => `/admin/products/new?error=${encodeURIComponent(msg)}`;

// POST /api/admin/products — create a product (with optional image), then redirect.
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  // The store's display unit, plus whether a blank weight would make this product
  // unsellable (every enabled zone prices by weight). Both come from settings the
  // request already loaded.
  const weightUnit = locals.settings?.weightUnit ?? 'g';
  const parsed = parseProductForm(form, {
    unit: weightUnit,
    requireWeight: zonesRequireWeight(shippingFor(locals.settings).config),
  });
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

  const deliverable = form.get('deliverable');
  if (attachmentActive() && deliverable instanceof File && deliverable.size > 0) {
    const fileError = validateDigitalFile(deliverable);
    if (fileError) return redirect(fail(fileError), 303);
  }

  // Slug from the optional slug field, else the name; made unique.
  const slugBase = String(form.get('slug') ?? '').trim() || parsed.data.name;
  const slug = await uniqueSlug(env.DB, slugBase);

  // image_key starts null and is derived from the gallery by syncPrimaryImage.
  // Writing the uploaded key here directly would be an UNGUARDED reference: the
  // media row is unreferenced until the attach lands, so a concurrent library
  // delete could leave the product pointing at an object that no longer exists.
  const productId = await createProduct(env.DB, { ...parsed.data, image_key: null, slug });
  if (attachmentActive() && deliverable instanceof File && deliverable.size > 0) {
    await setProductFile(env.DB, productId, await uploadDigitalFile(getFileStorage(), deliverable));
  }
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

  // Category membership arrives as cat_ public IDs; resolve to row ids at the
  // boundary (unknown/stale values are dropped, matching the old invalid-id path).
  const categoryPublicIds = form
    .getAll('category')
    .map((v) => parsePublicId(v, 'category'))
    .filter((v): v is string => v !== null);
  const categoryIds = (await getCategoriesByPublicIds(env.DB, categoryPublicIds)).map((c) => c.id);
  if (categoryIds.length > 0) await setProductCategories(env.DB, productId, categoryIds);

  // Keep the semantic-search index in sync (no-op unless vector search is on).
  // Never let an indexing hiccup block the create.
  const created = await getProduct(env.DB, productId);
  try {
    if (created) await indexProduct(created);
  } catch (err) {
    console.error('Search index (create) failed:', err);
  }

  await purgeCacheTags([
    CACHE_TAG.catalog,
    ...(created?.public_id ? [CACHE_TAG.product(created.public_id)] : []),
  ]);
  return redirect('/admin/products', 303);
};
