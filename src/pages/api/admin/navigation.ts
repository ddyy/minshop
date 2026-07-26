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
  MENU_CAPS,
} from '../../../features/navigation/db';

export const prerender = false;

const FAILURE_MESSAGES = {
  full: (location: string) =>
    `The ${location} menu is full (${MENU_CAPS[location as 'header' | 'footer']} items). Remove one first.`,
  duplicate: (location: string, what: string) => `${what} is already in the ${location} menu.`,
  unavailable: () => 'That page, product, or category is no longer available.',
};

// POST /api/admin/navigation — manage the header and footer menus.
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

  if (action === 'add') {
    const location = form.get('location');
    const targetType = form.get('target_type');
    if (!isMenuLocation(location)) return new Response('Invalid location', { status: 400 });
    if (!isMenuTargetType(targetType)) return new Response('Invalid target type', { status: 400 });

    // Singletons carry no target; the rest require a real integer id. A
    // non-integer is a malformed request (400), not a silently skipped insert.
    let targetId: number | null = null;
    if (!isSingleton(targetType)) {
      // The admin form renders one picker per type and hides all but the chosen
      // one — hidden controls still submit, so the field is namespaced and only
      // the one matching target_type is read. `target_id` stays accepted so a
      // direct API caller does not have to know that detail.
      const raw = Number(form.get(`target_id_${targetType}`) ?? form.get('target_id'));
      if (!Number.isInteger(raw)) return back('Choose a target first.');
      targetId = raw;
    }

    const result = await addMenuItem(env.DB, {
      location,
      targetType,
      targetId,
      label: normalizeLabel(form.get('label')),
    });
    if (result.ok) return back();

    const what = targetType === 'home' ? 'Home' : 'Catalog';
    return back(
      result.reason === 'full'
        ? FAILURE_MESSAGES.full(location)
        : result.reason === 'duplicate'
          ? FAILURE_MESSAGES.duplicate(location, what)
          : FAILURE_MESSAGES.unavailable(),
    );
  }

  // Drag-and-drop sends the whole order for one menu. Bounded by the menu's cap
  // so a tampered payload cannot make this arbitrarily large, and scoped by
  // location in the query so ids from the other menu are ignored.
  if (action === 'reorder') {
    const location = form.get('location');
    if (!isMenuLocation(location)) return new Response('Invalid location', { status: 400 });
    const ids = form
      .getAll('order')
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n))
      .slice(0, MENU_CAPS[location]);
    // Rejected rather than partially applied: a list that is not a complete,
    // duplicate-free permutation of this menu would leave rows sharing a
    // position. The client reloads on a non-OK response, so the merchant sees
    // the real order rather than an optimistic one.
    const applied = await reorderMenuItems(env.DB, location, ids);
    if (!applied) return back('That reorder did not match the menu. Reloading.');
    return back();
  }

  const id = Number(form.get('id'));
  if (!Number.isInteger(id)) return new Response('Invalid id', { status: 400 });

  if (action === 'move') {
    await moveMenuItem(env.DB, id, form.get('direction') === 'up' ? 'up' : 'down');
    return back();
  }

  if (action === 'remove') {
    await removeMenuItem(env.DB, id);
    return back();
  }

  if (action === 'label') {
    await setMenuItemLabel(env.DB, id, normalizeLabel(form.get('label')));
    return back();
  }

  return back('Unknown action.');
};
