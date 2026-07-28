import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getConfig } from '../../../../config';
import { getPageByPublicId, deletePage } from '../../../../features/pages/db';
import { parsePageForm } from '../../../../features/pages/form';
import { uniquePageSlug } from '../../../../features/pages/slug';
import { savePageBody, saveWarning } from '../../../../features/pages/save';
import { parsePublicId } from '../../../../features/ids/publicId';

export const prerender = false;

// POST /api/admin/pages/:id — save, or delete when `_action=delete`.
// :id is the page_ public ID; numeric row ids are not accepted.
export const POST: APIRoute = async ({ request, params, redirect }) => {
  const publicId = parsePublicId(params.id, 'page');
  const existing = publicId ? await getPageByPublicId(env.DB, publicId) : null;
  if (!existing) return new Response('Not found', { status: 404 });
  const id = existing.id;

  const form = await request.formData();

  if (String(form.get('_action')) === 'delete') {
    // Drops the page and its media associations. The files stay in the library.
    await deletePage(env.DB, id);
    return redirect('/admin/pages', 303);
  }

  const back = (query: string) => redirect(`/admin/pages/${publicId}/edit${query}`, 303);

  const parsed = parsePageForm(form);
  if ('error' in parsed) return back(`?error=${encodeURIComponent(parsed.error)}`);

  // Keep the slug stable on rename: the form pre-fills the current slug.
  const slugBase = parsed.data.slug || existing.slug || parsed.data.title;
  const slug = await uniquePageSlug(env.DB, slugBase, id);

  const result = await savePageBody(
    env.DB,
    existing,
    { ...parsed.data, slug },
    { baseUrl: getConfig().images.baseUrl },
  );

  const warning = saveWarning(result);
  return back(warning ? `?warning=${encodeURIComponent(warning)}` : '?saved=1');
};
