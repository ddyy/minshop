import type { Product } from '../products/db';
import { productImageSources, type ImageDelivery } from '../products/image';
import { requirePublicId } from '../catalog/serialize';
import { stockState } from '../products/stock';
import { formatMoney } from '../../money';
import type { ProductCardModel, StorefrontImage } from './models';

/**
 * Builders that turn authoritative product data into the presentation models
 * store-owned templates receive. Pure: no D1, no R2, no request context. Every
 * decision a template must not make — which delivery mode, which width ladder,
 * how money reads, whether the row is purchasable — is made here.
 */

export interface StorefrontImageOptions {
  /** config.images.baseUrl. Empty string keeps original `/images/...` delivery. */
  baseUrl?: string;
  /** The store's runtime image-delivery setting, already read from settings. */
  delivery?: ImageDelivery;
  /** Browser sizing hint for the slot this image occupies. */
  sizes?: string;
  /**
   * Marks the page's likely LCP image. Upstream owns this, not the template:
   * it selects the wider fallback candidate AND the eager/high-priority
   * attributes, and those two must never disagree. Carrying it on the resolved
   * image is what makes desync impossible.
   */
  priority?: boolean;
}

/**
 * Resolve an image key into final URLs. `usage` follows `priority` exactly as
 * ProductImage did — a priority image is the large one on the page, so it takes
 * the detail-sized fallback candidate.
 */
export function buildStorefrontImage(
  imageKey: string | null,
  alt: string,
  options: StorefrontImageOptions = {},
): StorefrontImage {
  const priority = options.priority ?? false;
  const sources = productImageSources(imageKey, {
    baseUrl: options.baseUrl,
    delivery: options.delivery,
    usage: priority ? 'detail' : 'card',
    sizes: options.sizes,
  });

  return {
    src: sources.src,
    ...(sources.srcset ? { srcset: sources.srcset } : {}),
    ...(sources.sizes ? { sizes: sources.sizes } : {}),
    alt,
    priority,
  };
}

export interface ProductCardOptions extends StorefrontImageOptions {
  /**
   * Currency to format the price in. Required, not defaulted: a default would
   * either read the store config — making this builder binding-aware, which is
   * what it must not be — or silently format in the wrong currency. Loaders
   * pass the store's configured currency.
   */
  currency: string;
}

/**
 * A product row as a card. Throws on a row without a public ID, matching the
 * catalog serializers: that is a deploy-order bug, and failing loudly beats
 * rendering a numeric row ID into a public page.
 */
export function buildProductCard(
  product: Product,
  options: ProductCardOptions,
): ProductCardModel {
  return {
    id: requirePublicId(product.public_id, product.id, 'product'),
    name: product.name,
    href: `/products/${product.slug}`,
    image: buildStorefrontImage(product.image_key, product.name, options),
    // The store's currency, not the row's: a product row can carry a legacy
    // currency, and the catalog has always displayed one consistent currency.
    formattedPrice: formatMoney(product.price_cents, options.currency),
    // Availability only — never the count. `stockState` is the authoritative
    // classification; re-deriving `stock > 0` here would fork that rule.
    inStock: stockState(product.stock) !== 'out',
  };
}
