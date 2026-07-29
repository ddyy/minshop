// A helper that looks innocuous from the importing control's point of view.
import { env } from 'cloudflare:workers';

export function storeName(): string {
  return String(env.CANONICAL_ORIGIN ?? '');
}
