import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  getProduct,
  listProductImages,
  replaceProductImageKey,
  updateProduct,
  deleteProduct,
} from '../../../../features/products/db';
import { parseProductForm } from '../../../../features/products/form';
import { uniqueSlug } from '../../../../features/products/slug';
import { setProductCategories } from '../../../../features/categories/db';
import { applyVariantForm } from '../../../../features/products/variants';
import { validateImage, uploadProductImage } from '../../../../features/products/image';
import { optimizeUpload } from '../../../../features/products/imageOptimize';
import { getStorage } from '../../../../features/storage';
import { indexProduct, unindexProduct } from '../../../../features/search';

export const prerender = false;

// POST /api/admin/products/:id — update (with optional image replace), or delete
// when `_action=delete`. (HTML forms can't send DELETE/PUT, so the verb is a field.)
export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id)) {
    return new Response('Invalid id', { status: 400 });
  }

  const form = await request.formData();
  const storage = getStorage();
  const existing = await getProduct(env.DB, id);

  if (String(form.get('_action')) === 'delete') {
    const gallery = await listProductImages(env.DB, id);
    const imageKeys = new Set([
      ...gallery.map((image) => image.image_key),
      ...(existing?.image_key ? [existing.image_key] : []),
    ]);
    await deleteProduct(env.DB, id);
    for (const key of imageKeys) {
      try {
        await storage.delete(key);
      } catch (err) {
        console.error(
          JSON.stringify({
            event: 'product_image_delete_failed',
            productId: id,
            key,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
    try {
      await unindexProduct(id); // no-op unless vector search is on
    } catch (err) {
      console.error('Search unindex (delete) failed:', err);
    }
    return redirect('/admin/products', 303);
  }

  const fail = (msg: string) =>
    redirect(`/admin/products/${id}/edit?error=${encodeURIComponent(msg)}`, 303);

  const parsed = parseProductForm(form);
  if ('error' in parsed) return fail(parsed.error);

  let image_key = existing?.image_key ?? null;
  let replacedImageKey: string | null = null;
  const file = form.get('image');
  if (file instanceof File && file.size > 0) {
    const imgErr = validateImage(file);
    if (imgErr) return fail(imgErr);
    image_key = await uploadProductImage(storage, await optimizeUpload(file));
    replacedImageKey = existing?.image_key ?? null;
  }

  // Keep the slug stable on rename: use the form's slug field (pre-filled with
  // the current slug), falling back to the existing slug, then the name.
  const slugBase = String(form.get('slug') ?? '').trim() || existing?.slug || parsed.data.name;
  const slug = await uniqueSlug(env.DB, slugBase, id);

  await updateProduct(env.DB, id, { ...parsed.data, image_key, slug });
  if (replacedImageKey && image_key) {
    await replaceProductImageKey(env.DB, id, replacedImageKey, image_key);
    // Switch every database reference before removing the old immutable object.
    await storage.delete(replacedImageKey);
  }

  // Replace category links (empty set clears them).
  const categoryIds = form
    .getAll('category')
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
  await setProductCategories(env.DB, id, categoryIds);

  // Variants + extras edited inline on the same form (no-op if none submitted).
  await applyVariantForm(env.DB, id, form, parsed.data.currency);

  // Re-embed for semantic search (no-op unless vector search is on).
  try {
    const updated = await getProduct(env.DB, id);
    if (updated) await indexProduct(updated);
  } catch (err) {
    console.error('Search index (update) failed:', err);
  }

  return redirect('/admin/products', 303);
};
