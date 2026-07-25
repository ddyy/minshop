import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createDraft } from '../../../features/pages/db';
import { uniquePageSlug } from '../../../features/pages/slug';

export const prerender = false;

// POST /api/admin/pages — create an unpublished draft, then send the author to
// the editor. Two steps on purpose: attaching media needs a page id, so the
// editor only opens once the row exists.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const title = String(form.get('title') ?? '').trim();
  if (!title) {
    return redirect(`/admin/pages/new?error=${encodeURIComponent('Title is required.')}`, 303);
  }

  const slugBase = String(form.get('slug') ?? '').trim() || title;
  const slug = await uniquePageSlug(env.DB, slugBase);
  const id = await createDraft(env.DB, title, slug);
  return redirect(`/admin/pages/${id}/edit`, 303);
};
