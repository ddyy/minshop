import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  countAllProducts,
  listProductsAfterId,
} from '../../../../features/products/db';
import { indexProducts } from '../../../../features/search';
import { getConfig } from '../../../../config';
import { getStoreSettings } from '../../../../features/settings/db';

export const prerender = false;

// One request stays comfortably below binding-operation limits even when every
// product needs an embedding, a Vectorize neighbour query, and a D1 update. The
// admin page automatically advances through these keyset batches.
const BATCH_SIZE = 5;

function nonNegativeInteger(value: FormDataEntryValue | null): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

// POST /api/admin/search/reindex — (re)build the semantic-search index from every
// product in bounded batches. JS advances automatically; without JS the redirect
// preserves the cursor and presents a "Continue reindex" button.
export const POST: APIRoute = async ({ request, redirect }) => {
  const wantsJson =
    request.headers.get('x-requested-with') === 'fetch' ||
    request.headers.get('accept')?.includes('application/json');
  const back = (msg: string, cursor = 0, processed = 0) => {
    const query = new URLSearchParams({ msg });
    if (cursor > 0) {
      query.set('reindex_cursor', String(cursor));
      query.set('reindex_processed', String(processed));
    }
    return redirect(`/admin/settings?${query.toString()}#search`, 303);
  };
  const fail = (message: string, status = 400) =>
    wantsJson
      ? Response.json({ error: message }, { status })
      : back(message);

  const settings = await getStoreSettings(env.DB);
  const provider = settings.searchProvider ?? getConfig().search.provider;
  if (provider !== 'vector') {
    return fail('Semantic search is off — enable it in Settings first.');
  }
  if (!env.AI || !env.VECTORIZE) {
    return fail('Semantic search is unavailable — add the AI and VECTORIZE bindings first.');
  }

  const form = await request.formData();
  const cursor = nonNegativeInteger(form.get('cursor'));
  const processedBefore = nonNegativeInteger(form.get('processed'));

  try {
    // Fetch one extra row to know whether another request is needed without a
    // separate look-ahead query. IDs are the cursor, so deletes cannot make us
    // skip or repeat rows the way OFFSET pagination can.
    const [rows, total] = await Promise.all([
      listProductsAfterId(env.DB, cursor, BATCH_SIZE + 1),
      countAllProducts(env.DB),
    ]);
    const batch = rows.slice(0, BATCH_SIZE);
    const n = await indexProducts(batch);
    const processed = Math.min(total, processedBefore + n);
    const done = rows.length <= BATCH_SIZE;
    const nextCursor = done ? null : batch.at(-1)?.id ?? cursor;

    if (wantsJson) {
      return Response.json({ processed, total, nextCursor, done });
    }
    return done
      ? back(`Reindexed ${processed} product(s) into the semantic search index.`)
      : back(
          `Reindexed ${processed} of ${total} products. Continue to process the next batch.`,
          nextCursor ?? cursor,
          processed,
        );
  } catch (err) {
    const message = `Reindex failed: ${(err as Error).message}`;
    return wantsJson
      ? Response.json({ error: message }, { status: 500 })
      : back(message, cursor, processedBefore);
  }
};
