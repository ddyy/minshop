import { handle } from '@astrojs/cloudflare/handler';
import { env } from 'cloudflare:workers';
import { sweepStaleNotifications } from './features/email/outbox';
import { releaseExpiredReservations } from './features/orders/reservations';
import { getSecret } from './features/secrets/store';
import { getSetting } from './features/settings/db';
import { syncPendingClickDropOrders } from './features/shipping/clickDropSync';

/**
 * Worker entrypoint.
 *
 * `fetch` is Astro's, unchanged — this file exists only so the Worker can also
 * export `scheduled`. (Astro's adapter generates the entry otherwise; the
 * wrangler `main` pointing here is what swaps it. See the Cloudflare adapter's
 * custom-entrypoint docs.)
 *
 * WHY a cron at all: every recurring job in minshop was previously driven by
 * incoming traffic — the notification sweep piggybacks on live settlements, and
 * expired inventory holds are released by the NEXT shopper's reservation. That
 * inverts the risk: the quieter the store, the longer a failed confirmation
 * email goes unretried and the longer sold-out-looking stock stays locked. A
 * store with one order a day could sit a full day in that state.
 *
 * Everything here is idempotent and bounded, because a cron can overlap a live
 * request doing the same work: the notification claim is a conditional UPDATE,
 * and reservation release is guarded per row. Nothing below is exclusive to the
 * cron — it is the same code the request paths call, just on a clock.
 */
async function runScheduledSweeps(): Promise<void> {
  const db = env.DB;

  // Inventory first: it needs no configuration and it is the one that silently
  // costs sales, since held stock reads as sold out to every shopper.
  try {
    await releaseExpiredReservations(db, 50);
  } catch (err) {
    console.error('Scheduled reservation sweep failed:', err);
  }

  // Notification retry needs an origin to build order links with, and a cron
  // has no request to take one from. rememberStoreUrl records it from live
  // traffic; until a first order has flowed there is nothing queued to retry
  // anyway, so skipping is correct rather than merely safe. Never guess here —
  // a wrong origin sends real customers dead links.
  let origin: string | null = null;
  try {
    origin = await getSetting(db, 'store_url');
    if (origin) {
      await sweepStaleNotifications(db, origin);
    }
  } catch (err) {
    console.error('Scheduled notification sweep failed:', err);
  }

  // Click & Drop has no webhook for custom API keys — poll orders we pushed
  // and fulfill when C&D shows printed/shipped/tracking.
  try {
    const token = await getSecret(db, 'royal_mail_click_drop_api_key');
    if (token) {
      await syncPendingClickDropOrders(db, token, { limit: 25, origin });
    }
  } catch (err) {
    console.error('Scheduled Click & Drop sync failed:', err);
  }
}

export default {
  fetch: handle,

  // Each sweep catches its own errors, so one failing job never strands the
  // others. waitUntil keeps the invocation alive for the whole pass.
  scheduled(_controller, _env, ctx) {
    ctx.waitUntil(runScheduledSweeps());
  },
  // Bindings are reached through the `cloudflare:workers` env import (as every
  // other module here does), so the handler itself needs no Env generic.
} satisfies ExportedHandler<Cloudflare.Env>;
