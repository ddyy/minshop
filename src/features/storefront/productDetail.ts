import type { D1Database } from '@cloudflare/workers-types';
import type { StoreSettings } from '../settings/db';
import { getProductBySlug, listProductImages, type Product } from '../products/db';
import { listVariants, listExtras } from '../products/variants';
import { categoriesForProduct, relatedProducts } from '../categories/db';
import { getRelatedStored, storeRelatedIds } from '../search';
import { enabledMethods } from '../payments';
import { productImageSources, productImageUrl, type ImageDelivery } from '../products/image';
import { stockState } from '../products/stock';
import { catalogPath } from '../settings/home';
import { formatMoney, toMajorUnits, currencyDecimals } from '../../money';
import { buildProductCard } from './productCard';
import type {
  ProductDetailModel,
  ProductPurchaseModel,
  ProductSeoModel,
  StorefrontGalleryImage,
  StorefrontImage,
} from './models';

/**
 * The product-detail loader.
 *
 * This route was the densest in the storefront: parallel graph reads, a
 * background backfill, cache tagging, variant and extra availability, gallery
 * derivation, SEO, runtime payment toggles, and two different purchase forms.
 * All of it lives here, so the template receives three finished models and
 * decides only composition.
 *
 * The route keeps what is not presentation: the 404, the metadata tags, the
 * JSON-LD script, and cache tagging.
 */

const RELATED_TARGET = 4;
const HERO_SIZES = '(min-width: 768px) 528px, calc(100vw - 48px)';
const THUMBNAIL_SIZES = '64px';
const RELATED_CARD_SIZES = '(min-width: 1024px) 252px, calc(50vw - 36px)';

export type LoadedProductDetail =
  | { status: 'not_found' }
  | {
      status: 'ok';
      model: ProductDetailModel;
      seo: ProductSeoModel;
      purchase: ProductPurchaseModel;
      /** Cache tags for the response; the route attaches them. */
      cacheTagIds: (string | null)[];
      /** Set when the semantic-neighbour column was empty and should be
       *  backfilled after the response is sent. */
      backfillRelated: (() => Promise<void>) | null;
    };

export interface ProductDetailOptions {
  slug: string | undefined;
  searchParams: URLSearchParams;
  settings: StoreSettings | undefined;
  imageBaseUrl: string;
  delivery: ImageDelivery | undefined;
  currency: string;
  /** Absolute origin for SEO URLs. */
  origin: string;
  pathname: string;
}

function heroImage(
  product: Product,
  options: ProductDetailOptions,
): StorefrontImage {
  const sources = productImageSources(product.image_key, {
    baseUrl: options.imageBaseUrl,
    delivery: options.delivery,
    usage: 'detail',
    sizes: HERO_SIZES,
  });
  return {
    src: sources.src,
    ...(sources.srcset ? { srcset: sources.srcset } : {}),
    ...(sources.sizes ? { sizes: sources.sizes } : {}),
    alt: product.name,
    // The product hero is the page's LCP candidate.
    priority: true,
  };
}

export async function loadProductDetail(
  db: D1Database,
  options: ProductDetailOptions,
): Promise<LoadedProductDetail> {
  const product = options.slug ? await getProductBySlug(db, options.slug) : null;
  if (!product) return { status: 'not_found' };

  // Independent once the product is known. Run together so an uncached render
  // pays one concurrent wait instead of a serial chain.
  const [categories, storedRelated, variants, extras, gallery] = await Promise.all([
    categoriesForProduct(db, product.id),
    getRelatedStored(product, RELATED_TARGET),
    listVariants(db, product.id),
    listExtras(db, product.id),
    listProductImages(db, product.id),
  ]);

  const semantic = storedRelated ?? [];
  let related = semantic;
  if (related.length < RELATED_TARGET) {
    const seen = new Set(related.map((p) => p.id));
    const byCategory = await relatedProducts(db, product.id, RELATED_TARGET + semantic.length);
    related = [...related, ...byCategory.filter((p) => !seen.has(p.id))].slice(0, RELATED_TARGET);
  }

  const hasVariants = variants.length > 0;
  const state = stockState(product.stock);
  // With variants the inventory unit is the variant, so availability comes from
  // them; otherwise from the product's own stock.
  const soldOut = hasVariants ? variants.every((v) => v.stock <= 0) : state === 'out';

  const variantPrices = variants.map((v) => v.price_cents);
  const displayPriceCents = hasVariants ? Math.min(...variantPrices) : product.price_cents;
  const priceVaries = hasVariants && Math.min(...variantPrices) !== Math.max(...variantPrices);

  // A variant's linked image reaches the markup as the gallery anchor (pimg_
  // public ID, image_key fallback) — the image_id row FK stays server-side.
  const galleryAnchor = (imageId: number | null): string => {
    const image = imageId == null ? undefined : gallery.find((g) => g.id === imageId);
    return image ? (image.public_id ?? image.image_key) : '';
  };
  const firstInStockIndex = variants.findIndex((v) => v.stock > 0);

  const images: StorefrontGalleryImage[] = gallery.map((image) => {
    const hero = productImageSources(image.image_key, {
      baseUrl: options.imageBaseUrl,
      delivery: options.delivery,
      usage: 'detail',
      sizes: HERO_SIZES,
    });
    const thumbnail = productImageSources(image.image_key, {
      baseUrl: options.imageBaseUrl,
      delivery: options.delivery,
      usage: 'thumbnail',
      sizes: THUMBNAIL_SIZES,
    });
    return {
      anchor: image.public_id ?? image.image_key,
      hero: { ...hero, alt: image.alt || product.name, priority: false },
      thumbnail: { ...thumbnail, alt: '', priority: false },
    };
  });

  const offered = options.settings ? enabledMethods(options.settings) : [];
  const canCheckout = offered.length > 0;
  const cartEnabled = options.settings?.cartEnabled ?? true;
  const buyNowEnabled = options.settings?.buyNowEnabled ?? true;

  const imagePath = productImageUrl(product.image_key, options.imageBaseUrl);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    ...(product.description ? { description: product.description } : {}),
    image: new URL(imagePath, options.origin).href,
    offers: {
      '@type': 'Offer',
      price: toMajorUnits(displayPriceCents, product.currency).toFixed(
        currencyDecimals(product.currency),
      ),
      priceCurrency: product.currency.toUpperCase(),
      availability: soldOut ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
      url: new URL(options.pathname, options.origin).href,
    },
  };

  return {
    status: 'ok',
    cacheTagIds: [product.public_id, ...related.map((candidate) => candidate.public_id)],
    backfillRelated:
      storedRelated === null ? () => storeRelatedIds(product.id, RELATED_TARGET) : null,
    seo: {
      title: product.name,
      description: product.description,
      imagePath,
      // Escape "<" so a product name can't break out of the <script> tag.
      jsonLd: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
    },
    model: {
      id: product.public_id ?? '',
      name: product.name,
      description: product.description,
      formattedPrice: formatMoney(displayPriceCents, options.currency),
      priceCents: product.price_cents,
      currency: product.currency,
      priceVaries,
      soldOut,
      // Deliberately never shown for a product with variants: the product-level
      // count means nothing when the variant is the inventory unit.
      lowStock: !hasVariants && state === 'low',
      categories: categories.map((category) => ({
        text: category.name,
        href: `/categories/${category.slug}`,
      })),
      images,
      heroImage: heroImage(product, options),
      related: related.map((candidate) =>
        buildProductCard(candidate, {
          baseUrl: options.imageBaseUrl,
          delivery: options.delivery,
          currency: options.currency,
          sizes: RELATED_CARD_SIZES,
        }),
      ),
      backHref: catalogPath(options.settings?.homePage),
      error: options.searchParams.get('error'),
    },
    purchase: {
      productId: product.public_id ?? '',
      cartAction: '/api/cart',
      expressAction: '/express',
      hasOptions: hasVariants || extras.length > 0,
      soldOut,
      showAddToCart: cartEnabled,
      // Buy now is express (it skips the cart), so it survives the cart being
      // switched off — but not the absence of any rail that can take money.
      showBuyNow: buyNowEnabled && canCheckout,
      variantLabel: product.variant_label,
      variants: variants.map((variant, index) => ({
        id: variant.public_id ?? '',
        label: variant.label,
        formattedPrice: formatMoney(variant.price_cents, options.currency),
        priceCents: variant.price_cents,
        soldOut: variant.stock <= 0,
        defaultSelected: index === firstInStockIndex,
        imageAnchor: galleryAnchor(variant.image_id),
      })),
      extras: extras.map((extra) => ({
        id: extra.public_id ?? '',
        label: extra.label,
        formattedPriceDelta: formatMoney(extra.price_delta_cents, options.currency),
        priceDeltaCents: extra.price_delta_cents,
      })),
    },
  };
}
