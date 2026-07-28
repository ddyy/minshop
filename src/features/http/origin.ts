/**
 * Stable origin for absolute URLs embedded in public, shared responses.
 * A configured value is deployment policy, so fail closed on malformed input
 * instead of silently putting a request-derived hostname into the shared cache.
 */
export function publicOrigin(
  requestOrigin: string,
  configuredOrigin: string | undefined,
): string {
  if (configuredOrigin === undefined) return new URL(requestOrigin).origin;

  const value = configuredOrigin.trim();
  if (!value) throw new Error('CANONICAL_ORIGIN must not be empty');

  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('CANONICAL_ORIGIN must be an HTTPS origin without a path');
  }
  return url.origin;
}
