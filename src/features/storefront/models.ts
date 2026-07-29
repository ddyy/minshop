/**
 * Presentation models for store-owned templates.
 *
 * These are the ONLY shapes an editable storefront file receives. Database rows
 * are deliberately absent: a row would publish internal numeric IDs, storage
 * keys, mutable columns, and query-specific accidents as a de facto contract,
 * and every one of those becomes something a template edit can break.
 *
 * Two rules govern what belongs here:
 *
 * 1. Values arrive resolved. A template never derives an R2 URL, calculates
 *    money, infers stock from a quantity, or constructs an API path.
 * 2. The contract stays as small as the default template needs. Every field is
 *    a compatibility promise; an unused one is a promise bought for nothing.
 */

/**
 * A fully resolved image. Never an image key and never an unresolved delivery
 * choice: `src`/`srcset` already reflect the store's original-vs-Cloudflare
 * setting and the usage's width ladder, decided in the builder where that
 * setting is known.
 */
export interface StorefrontImage {
  /** Root-relative or absolute URL; never an R2 key. */
  src: string;
  /** Responsive candidates, when the delivery mode produces a ladder. */
  srcset?: string;
  /** Browser sizing hint paired with `srcset`. */
  sizes?: string;
  alt: string;
  /**
   * Marks the page's likely LCP image. Upstream decides this, because it
   * selects both the wider fallback candidate and the eager/high-priority
   * attributes — a template that could set one without the other would be able
   * to silently regress LCP.
   */
  priority: boolean;
}

/** A product as a catalog/search/recommendation card. */
export interface ProductCardModel {
  /** `prod_` public ID. Never a row ID. */
  id: string;
  name: string;
  /** Root-relative product URL. */
  href: string;
  image: StorefrontImage;
  /** Server-formatted price in the store's currency. Display only — money is
   *  never posted back from a template as authority. */
  formattedPrice: string;
  /** Availability as a boolean, deliberately not a quantity: exact stock counts
   *  stay private, and bucket-level changes avoid cache invalidation. */
  inStock: boolean;
}
