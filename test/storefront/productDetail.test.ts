import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import ProductDetail from '../../src/storefront/ProductDetail.astro';
import AltProductDetail from './fixtures/product-detail/AltProductDetail.astro';
import ProductPurchaseForm from '../../src/features/storefront/controls/ProductPurchaseForm.astro';
import ProductGallery from '../../src/features/storefront/controls/ProductGallery.astro';
import type {
  ProductDetailModel,
  ProductPurchaseModel,
  StorefrontGalleryImage,
  StorefrontImage,
} from '../../src/features/storefront/models';

const image = (src: string, alt = 'Sample'): StorefrontImage => ({
  src,
  alt,
  priority: false,
});

const galleryImage = (anchor: string): StorefrontGalleryImage => ({
  anchor,
  hero: { ...image(`/images/${anchor}.jpg`), priority: false },
  thumbnail: { ...image(`/images/${anchor}-thumb.jpg`, ''), priority: false },
});

/** Frames as the loader builds them: the first is the LCP candidate. */
const galleryFrames = (...anchors: string[]): StorefrontGalleryImage[] =>
  anchors.map((anchor, index) => {
    const frame = galleryImage(anchor);
    return { ...frame, hero: { ...frame.hero, priority: index === 0 } };
  });

const purchase = (overrides: Partial<ProductPurchaseModel> = {}): ProductPurchaseModel => ({
  productId: 'prod_k7m2qx8vn6',
  cartAction: '/api/cart',
  expressAction: '/express',
  hasOptions: false,
  soldOut: false,
  showAddToCart: true,
  showBuyNow: true,
  variantLabel: null,
  variants: [],
  extras: [],
  ...overrides,
});

const withOptions = (overrides: Partial<ProductPurchaseModel> = {}) =>
  purchase({
    hasOptions: true,
    variantLabel: 'Size',
    variants: [
      {
        id: 'var_aaaaaaaaaa',
        label: 'Small',
        formattedPrice: '$24.00',
        priceCents: 2400,
        soldOut: false,
        defaultSelected: true,
        imageAnchor: 'pimg_front0001',
      },
      {
        id: 'var_bbbbbbbbbb',
        label: 'Large',
        formattedPrice: '$29.00',
        priceCents: 2900,
        soldOut: true,
        defaultSelected: false,
        imageAnchor: '',
      },
    ],
    extras: [
      {
        id: 'xtra_cccccccccc',
        label: 'Gift wrap',
        formattedPriceDelta: '$5.00',
        priceDeltaCents: 500,
      },
    ],
    ...overrides,
  });

const detail = (overrides: Partial<ProductDetailModel> = {}): ProductDetailModel => ({
  id: 'prod_k7m2qx8vn6',
  name: 'Sample Tee',
  description: 'A shirt.',
  formattedPrice: '$24.00',
  priceCents: 2400,
  currency: 'usd',
  priceVaries: false,
  soldOut: false,
  lowStock: false,
  categories: [{ text: 'Apparel', href: '/categories/apparel' }],
  images: [],
  heroImage: { ...image('/images/tee.jpg'), priority: true },
  related: [],
  backHref: '/',
  error: null,
  ...overrides,
});

const render = async (component: unknown, props: Record<string, unknown>) => {
  const container = await AstroContainer.create();
  // No request, no locals: the detail page renders from its models alone.
  return container.renderToString(component as never, { props });
};

describe('the purchase form', () => {
  it('submits public IDs, never row IDs', async () => {
    const html = await render(ProductPurchaseForm, { model: withOptions() });

    expect(html).toContain('name="product_id" value="prod_k7m2qx8vn6"');
    expect(html).toContain('value="var_aaaaaaaaaa"');
    expect(html).toContain('value="xtra_cccccccccc"');
    expect(html).not.toMatch(/value="\d+"/);
  });

  it('keeps the field names the cart API parses', async () => {
    const html = await render(ProductPurchaseForm, { model: withOptions() });

    expect(html).toContain('name="_action" value="add"');
    expect(html).toContain('name="variant_id"');
    expect(html).toContain('name="extra"');
    expect(html).toContain('action="/api/cart"');
  });

  it('marks buy-now with data-fullpage so the drawer does not capture it', async () => {
    // Without this the shell's cart script intercepts the submit and opens the
    // drawer instead of navigating to /express. Nothing errors; buy-now just
    // silently stops working.
    const options = await render(ProductPurchaseForm, { model: withOptions() });

    expect(options).toContain('data-fullpage');
    expect(options).toContain('formaction="/express"');
    expect(options).toContain('formmethod="GET"');
  });

  it('makes a sold-out variant unselectable but still visible', async () => {
    const html = await render(ProductPurchaseForm, { model: withOptions() });

    expect(html).toContain('disabled');
    expect(html).toContain('Large');
  });

  it('pre-selects the first purchasable variant so the form can submit', async () => {
    const html = await render(ProductPurchaseForm, { model: withOptions() });
    // Read the actual radio elements rather than a window around the value:
    // attribute order is the renderer's business, not the contract's.
    const radios = html.match(/<input[^>]*name="variant_id"[^>]*>/g) ?? [];
    const selected = radios.find((tag) => tag.includes('var_aaaaaaaaaa'));
    const soldOut = radios.find((tag) => tag.includes('var_bbbbbbbbbb'));

    expect(radios).toHaveLength(2);
    expect(selected).toContain('checked');
    expect(selected).toContain('required');
    // The sold-out one must not be pre-selected, or the form submits an
    // unpurchasable option by default.
    expect(soldOut).not.toContain('checked');
    expect(soldOut).toContain('disabled');
  });

  it('renders no purchase controls at all when sold out', async () => {
    const plain = await render(ProductPurchaseForm, { model: purchase({ soldOut: true }) });
    const options = await render(ProductPurchaseForm, { model: withOptions({ soldOut: true }) });

    expect(plain).not.toContain('action="/express"');
    expect(plain).not.toContain('<button');
    expect(options).not.toContain('data-fullpage');
  });

  it('drops add-to-cart when the store is browse-only but keeps buy-now', async () => {
    // Buy now goes through /express, which skips the cart, so switching the
    // cart off must not take instant purchase with it.
    const html = await render(ProductPurchaseForm, {
      model: purchase({ showAddToCart: false, showBuyNow: true }),
    });

    expect(html).not.toContain('action="/api/cart"');
    expect(html).toContain('action="/express"');
  });

  it('drops buy-now when no rail can take money', async () => {
    const html = await render(ProductPurchaseForm, {
      model: purchase({ showAddToCart: true, showBuyNow: false }),
    });

    expect(html).toContain('action="/api/cart"');
    expect(html).not.toContain('action="/express"');
  });

  it('renders nothing when both paths are off', async () => {
    const html = await render(ProductPurchaseForm, {
      model: purchase({ showAddToCart: false, showBuyNow: false }),
    });

    expect(html).not.toContain('<form');
  });

  it('never publishes a stock count', async () => {
    const html = await render(ProductPurchaseForm, { model: withOptions() });

    expect(html).not.toMatch(/data-stock=/);
    expect(html).not.toMatch(/\b\d+ (left|remaining|in stock)\b/i);
  });
});

describe('the product gallery', () => {
  it('gives only the first frame LCP treatment', async () => {
    const html = await render(ProductGallery, {
      images: galleryFrames('pimg_one', 'pimg_two'),
      hero: { ...image('/images/tee.jpg'), priority: true },
      soldOut: false,
    });

    expect(html.match(/loading="eager"/g)?.length).toBe(1);
    expect(html).toContain('fetchpriority="high"');
    expect(html.match(/loading="lazy"/g)?.length).toBeGreaterThan(1);
  });

  it('never fades the LCP frame', async () => {
    // An opacity:0 element is not a valid LCP candidate, so fading the eager
    // frame holds the paint back until load and undoes the head start.
    const html = await render(ProductGallery, {
      images: galleryFrames('pimg_one', 'pimg_two'),
      hero: { ...image('/images/tee.jpg'), priority: true },
      soldOut: false,
    });
    const frames = html.match(/<img[^>]*id="pi-[^"]*"[^>]*>/g) ?? [];

    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain('loading="eager"');
    expect(frames[0]).not.toContain('data-image-fade');
    expect(frames[1]).toContain('loading="lazy"');
    expect(frames[1]).toContain('data-image-fade');
  });

  it('anchors each frame so variants and thumbnails can target it', async () => {
    const html = await render(ProductGallery, {
      images: galleryFrames('pimg_one', 'pimg_two'),
      hero: { ...image('/images/tee.jpg'), priority: true },
      soldOut: false,
    });

    expect(html).toContain('id="pi-pimg_one"');
    expect(html).toContain('href="#pi-pimg_one"');
    expect(html).toContain('data-hero-track');
  });

  it('falls back to a single hero when there is nothing to scroll', async () => {
    const html = await render(ProductGallery, {
      images: [galleryImage('pimg_only')],
      hero: { ...image('/images/tee.jpg'), priority: true },
      soldOut: false,
    });

    expect(html).not.toContain('data-hero-track');
    expect(html).toContain('/images/tee.jpg');
  });

  it('publishes no storage keys or row IDs in its anchors', async () => {
    const html = await render(ProductGallery, {
      images: [galleryImage('pimg_one')],
      hero: { ...image('/images/tee.jpg'), priority: true },
      soldOut: false,
    });

    expect(html).not.toMatch(/id="pi-\d+"/);
  });
});

describe('the store-owned product detail', () => {
  it('renders from its models alone', async () => {
    const html = await render(ProductDetail, {
      model: detail(),
      purchase: purchase(),
    });

    expect(html).toContain('Sample Tee');
    expect(html).toContain('$24.00');
    expect(html).toContain('href="/categories/apparel"');
  });

  it('shows the low-stock nudge only when the model sets it', async () => {
    const without = await render(ProductDetail, { model: detail(), purchase: purchase() });
    const with_ = await render(ProductDetail, {
      model: detail({ lowStock: true }),
      purchase: purchase(),
    });

    expect(without).not.toContain('Low stock');
    expect(with_).toContain('Low stock');
  });

  it('carries the live-price hooks the script reads', async () => {
    const html = await render(ProductDetail, { model: detail(), purchase: purchase() });

    expect(html).toContain('data-price-display');
    expect(html).toContain('data-base="2400"');
    expect(html).toContain('data-currency="usd"');
  });

  it('surfaces a validated error message when one is present', async () => {
    const html = await render(ProductDetail, {
      model: detail({ error: 'Please choose a Size.' }),
      purchase: purchase(),
    });

    expect(html).toContain('Please choose a Size.');
  });
});

describe('an independently authored product page', () => {
  it('satisfies the same models with the purchase form above the gallery', async () => {
    // The gallery and the purchase form are coupled through DOM anchors, so a
    // composition that reverses them proves the coupling lives in the contract
    // rather than in the default template's ordering.
    const html = await render(AltProductDetail, {
      model: detail({ images: galleryFrames('pimg_one', 'pimg_two') }),
      purchase: withOptions(),
    });

    expect(html.indexOf('name="variant_id"')).toBeLessThan(html.indexOf('data-hero-track'));
    expect(html).toContain('data-fullpage');
    expect(html).toContain('id="pi-pimg_one"');
    // Its own wording for the sold-out badge, via the documented prop.
    expect(html).toContain('alt-detail');
  });

  it('renders related products without ProductCard', async () => {
    const html = await render(AltProductDetail, {
      model: detail({
        related: [
          {
            id: 'prod_related001',
            name: 'Other Thing',
            href: '/products/other-thing',
            image: image('/images/other.jpg'),
            formattedPrice: '$12.00',
            inStock: true,
          },
        ],
      }),
      purchase: purchase(),
    });

    expect(html).toContain('data-related="prod_related001"');
    expect(html).toContain('href="/products/other-thing"');
    expect(html).not.toContain('reveal group');
  });
});
