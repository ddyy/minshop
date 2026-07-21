import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createProduct, addProductImage, getProduct } from '../../../features/products/db';
import { setProductCategories } from '../../../features/categories/db';
import { indexProduct } from '../../../features/search';
import { parseProductForm } from '../../../features/products/form';
import { uniqueSlug } from '../../../features/products/slug';
import { validateImage, uploadProductImage } from '../../../features/products/image';
import { optimizeUpload } from '../../../features/products/imageOptimize';
import { getStorage } from '../../../features/storage';

export const prerender = false;

const fail = (msg: string) => `/admin/products/new?error=${encodeURIComponent(msg)}`;

// POST /api/admin/products — create a product (with optional image), then redirect.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const parsed = parseProductForm(form);
  if ('error' in parsed) return redirect(fail(parsed.error), 303);

  let image_key: string | null = null;
  const file = form.get('image');
  if (file instanceof File && file.size > 0) {
    const imgErr = validateImage(file);
    if (imgErr) return redirect(fail(imgErr), 303);
    image_key = await uploadProductImage(getStorage(), await optimizeUpload(file));
  }

  // Slug from the optional slug field, else the name; made unique.
  const slugBase = String(form.get('slug') ?? '').trim() || parsed.data.name;
  const slug = await uniqueSlug(env.DB, slugBase);

  const productId = await createProduct(env.DB, { ...parsed.data, image_key, slug });
  // Seed the gallery with the primary image so the product page can show it.
  if (image_key) await addProductImage(env.DB, productId, image_key);

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
