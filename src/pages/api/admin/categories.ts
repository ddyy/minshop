import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createCategory } from '../../../features/categories/db';
import { parseCategoryForm } from '../../../features/categories/form';
import { uniqueCategorySlug } from '../../../features/categories/slug';

export const prerender = false;

const fail = (msg: string) => `/admin/categories/new?error=${encodeURIComponent(msg)}`;

// POST /api/admin/categories — create a category, then redirect to the list.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const parsed = parseCategoryForm(form);
  if ('error' in parsed) return redirect(fail(parsed.error), 303);

  const slug = await uniqueCategorySlug(env.DB, parsed.data.slugInput || parsed.data.name);
  await createCategory(env.DB, {
    name: parsed.data.name,
    slug,
    parent_id: parsed.data.parentId,
  });
  return redirect('/admin/categories', 303);
};
