import type { APIRoute } from 'astro';
import { getConfig } from '../../../../config';
import { renderMarkdown } from '../../../../features/pages/markdown';
import {
  normalizePageLayout,
  pageLayoutStyle,
} from '../../../../features/pages/layouts';

export const prerender = false;

const MAX_BODY = 100_000; // same bound the page form enforces

/**
 * POST /api/admin/pages/preview — render Markdown with the REAL storefront
 * renderer and return the fragment.
 *
 * The editor's Preview tab posts here instead of parsing Markdown in the
 * browser. That keeps markdown-it out of the admin JavaScript bundle and makes
 * preview/storefront parity structural rather than something two
 * implementations have to agree on.
 *
 * A static filename beats the sibling [id].ts route, so this never collides
 * with a page whose id is "preview".
 */
export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const markdown = String(form.get('body_markdown') ?? '').slice(0, MAX_BODY);
  const html = renderMarkdown(markdown, { baseUrl: getConfig().images.baseUrl });
  // Wrap in the same article element the storefront uses, so the preview shows
  // the chosen layout rather than always rendering at the default measure.
  const layout = normalizePageLayout(form.get('layout'));
  const wrapped =
    `<div class="markdown-content" data-page-layout="${layout}" ` +
    `style="${pageLayoutStyle(layout)}">${html}</div>`;

  return new Response(wrapped, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  });
};
