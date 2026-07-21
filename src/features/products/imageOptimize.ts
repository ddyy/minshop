import { env } from 'cloudflare:workers';
import { getConfig } from '../../config';

/**
 * Optionally downscale + recompress an uploaded image to WebP before it's stored,
 * via the Cloudflare Images binding. Controlled by config.images.optimizeOnUpload:
 *
 *   - OFF (default): the original file is stored unchanged — $0, fully local.
 *   - ON: transforms via the Cloudflare Images binding — free up to 5,000/mo, then
 *     usage-billed (separate from the Workers plan; works on Workers Free). Runs in
 *     local dev too — miniflare's offline binding supports the width + format we use
 *     (verified); `wrangler dev --remote` uses the production transformer.
 *
 * The fallback (and the try/catch) mean enabling it can never break an upload —
 * if the binding is missing or errors, you just store the original.
 */
export async function optimizeUpload(file: File): Promise<File> {
  const cfg = getConfig().images;
  // Feature off, or the IMAGES binding isn't declared (free-plan default) → store as-is.
  if (!cfg.optimizeOnUpload || !env.IMAGES) return file;

  try {
    const out = await env.IMAGES.input(file.stream())
      .transform({ width: cfg.maxWidth })
      .output({ format: 'image/webp', quality: 82 });
    const buf = await out.response().arrayBuffer();
    if (buf.byteLength === 0) return file;
    return new File([buf], 'optimized.webp', { type: 'image/webp' });
  } catch {
    return file; // transformation unavailable (e.g. local dev) — keep the original
  }
}
