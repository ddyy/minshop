import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createCategory, getCategoryByPublicId } from '../../../features/categories/db';
import { parseCategoryForm } from '../../../features/categories/form';
import { uniqueCategorySlug } from '../../../features/categories/slug';
import { CACHE_TAG } from '../../../features/cache/tags';
import { purgeCacheTags } from '../../../features/cache/purge';

export const prerender = false;

const fail = (msg: string) => `/admin/categories/new?error=${encodeURIComponent(msg)}`;

// POST /api/admin/categories — create a category, then redirect to the list.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const parsed = parseCategoryForm(form);
  if ('error' in parsed) return redirect(fail(parsed.error), 303);

  // The parent selector submits a cat_ public ID; resolve it to the row id here
  // at the boundary — relationship writes stay integer internally.
  let parentId: number | null = null;
  if (parsed.data.parentPublicId) {
    const parent = await getCategoryByPublicId(env.DB, parsed.data.parentPublicId);
    if (!parent) return redirect(fail('That parent category no longer exists.'), 303);
    parentId = parent.id;
  }

  const slug = await uniqueCategorySlug(env.DB, parsed.data.slugInput || parsed.data.name);
  await createCategory(env.DB, {
    name: parsed.data.name,
    slug,
    parent_id: parentId,
  });
  await purgeCacheTags([CACHE_TAG.catalog]);
  return redirect('/admin/categories', 303);
};
