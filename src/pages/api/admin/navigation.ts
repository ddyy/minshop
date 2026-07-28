import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  addMenuItem,
  moveMenuItem,
  reorderMenuItems,
  removeMenuItem,
  setMenuItemLabel,
  normalizeLabel,
  isMenuLocation,
  isMenuTargetType,
  isSingleton,
  getMenuItemIdByPublicId,
  menuItemIdsByPublicId,
  MENU_CAPS,
  type MenuTargetType,
} from '../../../features/navigation/db';
import { getPageByPublicId } from '../../../features/pages/db';
import { getProductByPublicId } from '../../../features/products/db';
import { getCategoryByPublicId } from '../../../features/categories/db';
import { parsePublicId } from '../../../features/ids/publicId';
import { CACHE_TAG } from '../../../features/cache/tags';
import { purgeCacheTags } from '../../../features/cache/purge';

export const prerender = false;

const FAILURE_MESSAGES = {
  full: (location: string) =>
    `The ${location} menu is full (${MENU_CAPS[location as 'header' | 'footer']} items). Remove one first.`,
  duplicate: (location: string, what: string) => `${what} is already in the ${location} menu.`,
  unavailable: () => 'That page, product, or category is no longer available.',
};

/**
 * Resolve a submitted target public ID (page_/prod_/cat_) to the internal row
 * id. Resolution happens once, here at the boundary; the guarded insert keeps
 * re-checking availability with integer ids. Numeric ids are never accepted.
 */
async function resolveTargetId(
  targetType: MenuTargetType,
  raw: unknown,
): Promise<number | null> {
  if (targetType === 'page') {
    const publicId = parsePublicId(raw, 'page');
    return publicId ? ((await getPageByPublicId(env.DB, publicId))?.id ?? null) : null;
  }
  if (targetType === 'product') {
    const publicId = parsePublicId(raw, 'product');
    return publicId ? ((await getProductByPublicId(env.DB, publicId))?.id ?? null) : null;
  }
  if (targetType === 'category') {
    const publicId = parsePublicId(raw, 'category');
    return publicId ? ((await getCategoryByPublicId(env.DB, publicId))?.id ?? null) : null;
  }
  return null;
}

// POST /api/admin/navigation — manage the header and footer menus.
// Items are addressed by their nav_ public IDs; targets by page_/prod_/cat_.
//   _action=add     → append an item to a menu
//   _action=move    → swap an item with its neighbour (direction=up|down)
//   _action=reorder → set the whole order of one menu (drag-and-drop)
//   _action=remove  → delete an item
//   _action=label   → set or clear the label override
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const action = String(form.get('_action'));

  /**
   * Redirect back to the page the merchant was on, in the state they left it.
   *
   * Adding several items to the footer is the normal case, and a bare redirect
   * reset the "Add to" selector to Header every time — so the second and third
   * add silently went to the wrong menu unless the merchant re-picked it.
   *
   * The submitted form wins for the fields it carries (the merchant may have
   * changed the type or destination without reloading); the referer supplies the
   * rest, so row actions like move/remove keep the picker where it was without
   * every row form having to carry hidden copies of it.
   */
  // The Up/Down buttons post via fetch when JS is available, purely to skip the
  // page reload. A 303 there would make fetch follow the redirect and download
  // the whole admin page for every click, so answer those with no body at all.
  // Same handler, same guarantees — only the response shape differs.
  const wantsNoContent = request.headers.get('x-partial') === '1';

  const back = (msg?: string) => {
    if (wantsNoContent) {
      return msg
        ? new Response(msg, { status: 400, headers: { 'content-type': 'text/plain' } })
        : new Response(null, { status: 204 });
    }
    const params = new URLSearchParams();
    const referer = request.headers.get('referer');
    if (referer) {
      try {
        const prev = new URL(referer).searchParams;
        for (const key of ['location', 'target_type', 'q']) {
          const value = prev.get(key);
          if (value) params.set(key, value);
        }
      } catch {
        // Malformed referer — fall back to whatever the form supplied.
      }
    }
    for (const key of ['location', 'target_type']) {
      const value = form.get(key);
      if (typeof value === 'string' && value !== '') params.set(key, value);
    }
    if (msg) params.set('error', msg);
    else params.set('saved', '1');
    return redirect(`/admin/navigation?${params}`, 303);
  };
  const saved = async () => {
    await purgeCacheTags([CACHE_TAG.shell]);
    return back();
  };

  if (action === 'add') {
    const location = form.get('location');
    const targetType = form.get('target_type');
    if (!isMenuLocation(location)) return new Response('Invalid location', { status: 400 });
    if (!isMenuTargetType(targetType)) return new Response('Invalid target type', { status: 400 });

    // Singletons carry no target; the rest submit a public ID that must resolve.
    let targetId: number | null = null;
    if (!isSingleton(targetType)) {
      // The admin form renders one picker per type and hides all but the chosen
      // one — hidden controls still submit, so the field is namespaced and only
      // the one matching target_type is read. `target_id` stays accepted so a
      // direct API caller does not have to know that detail.
      const raw = form.get(`target_id_${targetType}`) ?? form.get('target_id');
      targetId = await resolveTargetId(targetType, raw);
      if (targetId === null) return back('Choose a target first.');
    }

    const result = await addMenuItem(env.DB, {
      location,
      targetType,
      targetId,
      label: normalizeLabel(form.get('label')),
    });
    if (result.ok) return saved();

    const what = targetType === 'home' ? 'Home' : 'Catalog';
    return back(
      result.reason === 'full'
        ? FAILURE_MESSAGES.full(location)
        : result.reason === 'duplicate'
          ? FAILURE_MESSAGES.duplicate(location, what)
          : FAILURE_MESSAGES.unavailable(),
    );
  }

  // Drag-and-drop sends the whole order for one menu, as nav_ public IDs.
  // Resolved through one location-scoped map, so ids from the other menu (or
  // a tampered payload) simply drop out and fail the permutation check below.
  if (action === 'reorder') {
    const location = form.get('location');
    if (!isMenuLocation(location)) return new Response('Invalid location', { status: 400 });
    const byPublicId = await menuItemIdsByPublicId(env.DB, location);
    const ids = form
      .getAll('order')
      .map((v) => parsePublicId(v, 'navItem'))
      .map((pid) => (pid ? byPublicId.get(pid) : undefined))
      .filter((n): n is number => n !== undefined)
      .slice(0, MENU_CAPS[location]);
    // Rejected rather than partially applied: a list that is not a complete,
    // duplicate-free permutation of this menu would leave rows sharing a
    // position. The client reloads on a non-OK response, so the merchant sees
    // the real order rather than an optimistic one.
    const applied = await reorderMenuItems(env.DB, location, ids);
    if (!applied) return back('That reorder did not match the menu. Reloading.');
    return saved();
  }

  // Row actions address the item by its nav_ public ID.
  const itemPublicId = parsePublicId(form.get('id'), 'navItem');
  const id = itemPublicId ? await getMenuItemIdByPublicId(env.DB, itemPublicId) : null;
  if (id === null) return new Response('Invalid id', { status: 400 });

  if (action === 'move') {
    await moveMenuItem(env.DB, id, form.get('direction') === 'up' ? 'up' : 'down');
    return saved();
  }

  if (action === 'remove') {
    await removeMenuItem(env.DB, id);
    return saved();
  }

  if (action === 'label') {
    await setMenuItemLabel(env.DB, id, normalizeLabel(form.get('label')));
    return saved();
  }

  return back('Unknown action.');
};
