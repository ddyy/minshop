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

/** A resolved navigation link. Targets are validated upstream, so a template
 *  never renders a dead link or has to ask whether one is publishable. */
export interface StorefrontLink {
  text: string;
  href: string;
}

/**
 * Everything the header and footer need, for every route that renders them.
 *
 * The shell is not browse-only: it wraps cart, checkout, payment, account, and
 * Admin login too. So this model is deliberately inert — links, labels, and
 * flags. Nothing here can start a request or change state.
 */
export interface StorefrontShellModel {
  storeName: string;
  /** Resolved header logo, or null to fall back to the store name as text. */
  logo: StorefrontImage | null;
  /** Escaped message plus an already-validated link, or null when unset. */
  announcement: { text: string; href: string | null } | null;
  headerLinks: StorefrontLink[];
  footerLinks: StorefrontLink[];
  /** Form action plus the current query, so the field repopulates on /search. */
  search: { action: string; query: string };
  cart: { enabled: boolean; href: string };
  account: { enabled: boolean; href: string };
}

/** One sort control. `current` marks the field the list is ordered by; clicking
 *  it again flips direction, which is why `href` already carries the flip. */
export interface StorefrontSortOption {
  label: string;
  href: string;
  current: boolean;
  /** Direction currently applied, on the current option only. */
  direction: 'asc' | 'desc' | null;
}

export interface StorefrontSortModel {
  options: StorefrontSortOption[];
}

/** A page link, or an elision gap when `page` is null. */
export interface StorefrontPaginationItem {
  page: number | null;
  href: string | null;
  current: boolean;
}

export interface StorefrontPaginationModel {
  page: number;
  totalPages: number;
  prevHref: string | null;
  nextHref: string | null;
  /** Windowed page list, gaps included — e.g. 1 … 4 5 6 … 20. */
  items: StorefrontPaginationItem[];
}

/**
 * The catalog, rendered at both `/` and `/products`.
 *
 * Every URL here is already built and bounded. A template neither parses query
 * parameters nor constructs them: page and sort links carry the exact query
 * semantics the catalog depends on, including dropping defaults so the canonical
 * URL stays clean and cacheable.
 */
export interface CatalogPageModel {
  eyebrow: string;
  heading: string;
  categories: StorefrontLink[];
  products: ProductCardModel[];
  sort: StorefrontSortModel;
  pagination: StorefrontPaginationModel;
}

/**
 * One gallery image. `anchor` is the in-page target the thumbnails link to and
 * the variant selector points at — a `pimg_` public ID (the object key only as
 * a pre-backfill fallback), never a row ID.
 */
export interface StorefrontGalleryImage {
  anchor: string;
  hero: StorefrontImage;
  thumbnail: StorefrontImage;
}

/** A selectable variant. `priceCents` is present because the live price script
 *  reads it; it is display-only, and the server recomputes every total. */
export interface StorefrontVariant {
  id: string;
  label: string;
  formattedPrice: string;
  priceCents: number;
  soldOut: boolean;
  /** The first in-stock variant, pre-selected so the form is submittable. */
  defaultSelected: boolean;
  /** Gallery anchor to scroll to when this variant is chosen; '' when none. */
  imageAnchor: string;
}

/** A checkbox add-on layered on the line price. */
export interface StorefrontExtra {
  id: string;
  label: string;
  formattedPriceDelta: string;
  priceDeltaCents: number;
}

/**
 * Everything the purchase controls need, with every decision already made.
 *
 * A template must not receive stock quantities or re-derive which buttons to
 * show: `soldOut` already accounts for variant-level inventory, and
 * `showAddToCart`/`showBuyNow` already fold in the store's runtime cart and
 * buy-now toggles and whether any payment rail can actually take money.
 */
export interface ProductPurchaseModel {
  /** `prod_` public ID, submitted by both forms. */
  productId: string;
  cartAction: string;
  expressAction: string;
  hasOptions: boolean;
  soldOut: boolean;
  showAddToCart: boolean;
  showBuyNow: boolean;
  /** Merchant's name for the variant group, e.g. "Size". */
  variantLabel: string | null;
  variants: StorefrontVariant[];
  extras: StorefrontExtra[];
}

/** Metadata the ROUTE emits. Never handed to a template: escaping and canonical
 *  correctness are not presentation decisions. */
export interface ProductSeoModel {
  title: string;
  description: string | null;
  /** Root-relative image path for the social card. */
  imagePath: string;
  /** Serialized JSON-LD, already escaped for embedding in a script tag. */
  jsonLd: string;
}

export interface ProductDetailModel {
  id: string;
  name: string;
  /** Raw Markdown source (also what the catalog API returns). */
  description: string | null;
  /** Rendered, sanitized HTML (renderMarkdown: raw HTML escaped, schemes
   *  filtered). Themes show THIS, inside their .markdown-content prose styles —
   *  never the raw source. */
  descriptionHtml: string | null;
  /** Lowest variant price when they differ, else the product price. */
  formattedPrice: string;
  /** Raw minor units for the live price script; display-only. */
  priceCents: number;
  currency: string;
  /** True when variants disagree on price, so the header reads "from …". */
  priceVaries: boolean;
  soldOut: boolean;
  /** Low-stock nudge, already gated: never set for a product with variants. */
  lowStock: boolean;
  digitalDelivery: boolean;
  categories: StorefrontLink[];
  /** More than one image means the gallery renderer; one or none is the single
   *  hero. The distinction is the template's to make. */
  images: StorefrontGalleryImage[];
  /** Hero for the single-image case, already resolved. */
  heroImage: StorefrontImage;
  related: ProductCardModel[];
  /** Where "back to shop" goes — the catalog, wherever the merchant put it. */
  backHref: string;
  /** Validated message from ?error=, or null. */
  error: string | null;
}

/**
 * A merchant-authored content page.
 *
 * `html` is ALREADY rendered from Markdown and sanitized. A template embeds it
 * and does not parse, re-sanitize, or transform it: the trusted-HTML boundary
 * is upstream, and moving any part of it into an editable file would move the
 * XSS surface with it.
 */
export interface ContentPageModel {
  title: string;
  /** Rendered, sanitized page body. */
  html: string;
  /** Layout preset key, exposed as a data attribute so presets can target it. */
  layout: string;
  /** Inline custom properties for the preset's measure and title alignment. */
  layoutStyle: string;
}
