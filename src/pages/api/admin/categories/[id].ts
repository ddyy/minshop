import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  updateCategory,
  deleteCategory,
  descendantIds,
} from '../../../../features/categories/db';
import { parseCategoryForm } from '../../../../features/categories/form';
import { uniqueCategorySlug } from '../../../../features/categories/slug';

export const prerender = false;

// POST /api/admin/categories/:id — update, or delete when `_action=delete`.
export const POST: APIRoute = async ({ request, params, redirect }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id)) {
    return new Response('Invalid id', { status: 400 });
  }

  const form = await request.formData();

  if (String(form.get('_action')) === 'delete') {
    await deleteCategory(env.DB, id);
    return redirect('/admin/categories', 303);
  }

  const fail = (msg: string) =>
    redirect(`/admin/categories/${id}/edit?error=${encodeURIComponent(msg)}`, 303);

  const parsed = parseCategoryForm(form);
  if ('error' in parsed) return fail(parsed.error);

  // Cycle guard: a category can't be its own ancestor.
  if (parsed.data.parentId != null) {
    const blocked = new Set(await descendantIds(env.DB, id));
    if (blocked.has(parsed.data.parentId)) {
      return fail('A category cannot be moved under itself or one of its sub-categories.');
    }
  }

  const slug = await uniqueCategorySlug(env.DB, parsed.data.slugInput || parsed.data.name, id);
  await updateCategory(env.DB, id, {
    name: parsed.data.name,
    slug,
    parent_id: parsed.data.parentId,
  });
  return redirect('/admin/categories', 303);
};
