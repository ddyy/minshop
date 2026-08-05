import type { MenuItem } from '../navigation/db';
import { mediaUrl } from '../media/url';
import type { StorefrontLink, StorefrontShellModel } from './models';

/**
 * Builds the header/footer model.
 *
 * Pure by construction: everything it needs is passed in, already loaded. The
 * shell renders on every document route including checkout and the pay page, so
 * adding a query here would put a database round trip on the critical path of
 * the routes least able to afford one. Settings and menus arrive from the single
 * batched read middleware already performs.
 */
export interface ShellInput {
  storeName: string;
  /** Header logo object key, or null for the text fallback. */
  logoImageKey: string | null;
  /** config.images.baseUrl — empty string keeps `/images/...` delivery. */
  imageBaseUrl: string;
  /** Empty message means "no announcement"; the message is its own switch. */
  announcement: string;
  /** Already validated upstream. Empty string renders the text unlinked. */
  announcementHref: string;
  /** Menu items, already filtered to the publishable ones. */
  headerItems: MenuItem[];
  footerItems: MenuItem[];
  /** Current search term, normalized, or '' when not on the search route. */
  searchQuery: string;
  cartEnabled: boolean;
  accountsEnabled: boolean;
}

const toLink = (item: MenuItem): StorefrontLink => ({ text: item.text, href: item.href });

export function buildShellModel(input: ShellInput): StorefrontShellModel {
  return {
    storeName: input.storeName,
    logo: input.logoImageKey
      ? {
          src: mediaUrl(input.logoImageKey, input.imageBaseUrl),
          alt: input.storeName,
          // The header logo is above the fold on every route, so it is never
          // lazy. It has no responsive ladder — one small asset, no usage
          // variants — which is why it carries no srcset or sizes.
          priority: true,
        }
      : null,
    announcement: input.announcement
      ? { text: input.announcement, href: input.announcementHref || null }
      : null,
    headerLinks: input.headerItems.map(toLink),
    footerLinks: input.footerItems.map(toLink),
    search: { action: '/search', query: input.searchQuery },
    cart: { enabled: input.cartEnabled, href: '/cart' },
    account: { enabled: input.accountsEnabled, href: '/account' },
  };
}
