/**
 * Public URL for a stored object. The single place that knows how a media key
 * becomes a URL, so products, pages, and branding cannot drift apart.
 *
 * With `baseUrl` set (config.images.baseUrl, from IMAGE_BASE_URL — e.g. an R2
 * custom domain) it returns an absolute URL that bypasses the Worker's /images
 * route; otherwise a root-relative `/images/...` path.
 */
export function mediaUrl(imageKey: string, baseUrl = ''): string {
  return baseUrl ? `${baseUrl}/${imageKey}` : `/images/${imageKey}`;
}
