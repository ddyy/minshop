import { isAccessToken } from '../ids/token';

const FORM_CONTENT_TYPES = [
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function hasFormContentType(contentType: string | null): boolean {
  const value = contentType?.toLowerCase() ?? '';
  return FORM_CONTENT_TYPES.some((type) => value.includes(type));
}

function isCapabilityPayPath(pathname: string): boolean {
  if (!pathname.startsWith('/pay/')) return false;
  const token = pathname.slice('/pay/'.length);
  return !token.includes('/') && isAccessToken(token);
}

/**
 * Astro's origin guard, with one narrow compatibility exception.
 *
 * A new-style /pay/otk_… URL is itself a 128-bit bearer capability and does
 * not use cookie-authenticated authority. Its form may therefore work in
 * privacy-focused clients that omit or rewrite Origin. Every other form-like
 * mutation retains Astro's same-origin rule.
 */
export function isForbiddenFormOrigin(request: Request, url: URL): boolean {
  if (SAFE_METHODS.has(request.method)) return false;

  const originMatches = request.headers.get('origin') === url.origin;
  if (!request.headers.has('content-type')) return !originMatches;
  if (!hasFormContentType(request.headers.get('content-type'))) return false;
  if (originMatches) return false;

  return !(request.method === 'POST' && isCapabilityPayPath(url.pathname));
}
