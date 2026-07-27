import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  getProduct,
  syncPrimaryImage,
  updateProduct,
  deleteProduct,
} from '../../../../features/products/db';
import { parseProductForm } from '../../../../features/products/form';
import { zonesRequireWeight } from '../../../../features/shipping/calculator';
import { shippingFor } from '../../../../features/shipping/effective';
import { uniqueSlug } from '../../../../features/products/slug';
import { setProductCategories } from '../../../../features/categories/db';
import { applyVariantForm, validateVariantWeights } from '../../../../features/products/variants';
import { validateImage } from '../../../../features/products/image';
import { optimizeUpload } from '../../../../features/products/imageOptimize';
import { uploadMedia } from '../../../../features/media/upload';
import {
  attachMediaToProduct,
  replaceProductImageFromMedia,
} from '../../../../features/media/db';
import { getStorage } from '../../../../features/storage';
import { indexProduct, unindexProduct } from '../../../../features/search';

export const prerender = false;

// POST /api/admin/products/:id — update (with optional image replace), or delete
// when `_action=delete`. (HTML forms can't send DELETE/PUT, so the verb is a field.)
export const POST: APIRoute = async ({ request, params, redirect, locals }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id)) {
    return new Response('Invalid id', { status: 400 });
  }

  const form = await request.formData();
  const storage = getStorage();
  const existing = await getProduct(env.DB, id);

  if (String(form.get('_action')) === 'delete') {
    // Removes the product and its image ASSOCIATIONS. The files stay in the
    // media library — they may be used by other products or pages, and the
    // library is the only place an object is deleted.
    await deleteProduct(env.DB, id);
    try {
      await unindexProduct(id); // no-op unless vector search is on
    } catch (err) {
      console.error('Search unindex (delete) failed:', err);
    }
    return redirect('/admin/products', 303);
  }

  const fail = (msg: string) =>
    redirect(`/admin/products/${id}/edit?error=${encodeURIComponent(msg)}`, 303);

  // The store's display unit, plus whether a blank weight would make this product
  // unsellable (every enabled zone prices by weight). Both come from settings the
  // request already loaded.
  const weightUnit = locals.settings?.weightUnit ?? 'g';
  const parsed = parseProductForm(form, {
    unit: weightUnit,
    requireWeight: zonesRequireWeight(shippingFor(locals.settings).config),
  });
  if ('error' in parsed) return fail(parsed.error);

  // Weights are checked before ANY write. applyVariantForm runs last, after the
  // image, product, and category mutations — reporting the error from there left
  // a half-saved edit behind the failure page.
  const badWeight = validateVariantWeights(form, weightUnit);
  if (badWeight) return fail(badWeight);

  // The uploaded key is NOT written to products.image_key here: that reference
  // would be unguarded, and the media row is deletable until something claims
  // it. The gallery claim below is guarded, and syncPrimaryImage then derives
  // products.image_key from it.
  const image_key = existing?.image_key ?? null;
  let uploadedMediaId: number | null = null;
  const file = form.get('image');
  if (file instanceof File && file.size > 0) {
    const imgErr = validateImage(file);
    if (imgErr) return fail(imgErr);
    const media = await uploadMedia(env.DB, storage, await optimizeUpload(file), file.name);
    uploadedMediaId = media.id;
  }

  // Keep the slug stable on rename: use the form's slug field (pre-filled with
  // the current slug), falling back to the existing slug, then the name.
  const slugBase = String(form.get('slug') ?? '').trim() || existing?.slug || parsed.data.name;
  const slug = await uniqueSlug(env.DB, slugBase, id);

  // Claim the image BEFORE committing anything else. A failed claim then aborts
  // with nothing written; doing it afterwards reported an image error while the
  // name, price, and stock edits had already been saved.
  if (uploadedMediaId !== null) {
    // Repoint the gallery row at the new media, guarded on that row still
    // existing. The replaced object is NOT deleted: it stays in the library,
    // where it may be reused or removed deliberately once nothing uses it.
    const claimed = image_key
      ? await replaceProductImageFromMedia(env.DB, id, image_key, uploadedMediaId)
      : false;
    if (!claimed) {
      // Either the product had no gallery row to repoint, or it did and the
      // media vanished. Attaching distinguishes the two and reports properly.
      const attached = await attachMediaToProduct(env.DB, id, uploadedMediaId);
      if (!attached.ok) return fail(attached.error);
    }
  }

  await updateProduct(env.DB, id, { ...parsed.data, image_key, slug });
  // products.image_key follows the gallery, so this runs after both.
  if (uploadedMediaId !== null) await syncPrimaryImage(env.DB, id);

  // Replace category links (empty set clears them).
  const categoryIds = form
    .getAll('category')
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
  await setProductCategories(env.DB, id, categoryIds);

  // Variants + extras edited inline on the same form (no-op if none submitted).
  // A bad variant weight is reported rather than dropped: applyVariantForm
  // validates every weight before it writes anything.
  const variantResult = await applyVariantForm(env.DB, id, form, parsed.data.currency, weightUnit);
  if (variantResult.error) return fail(variantResult.error);

  // Re-embed for semantic search (no-op unless vector search is on).
  try {
    const updated = await getProduct(env.DB, id);
    if (updated) await indexProduct(updated);
  } catch (err) {
    console.error('Search index (update) failed:', err);
  }

  return redirect('/admin/products', 303);
};
