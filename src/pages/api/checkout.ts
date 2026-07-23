import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getProduct, getProductBySlug, type Product } from '../../features/products/db';
import {
  listVariants,
  getExtrasByIds,
  type ProductVariant,
  type ProductExtra,
} from '../../features/products/variants';
import { lineUnitPriceCents } from '../../features/cart/key';
import { productImageUrl } from '../../features/products/image';
import { readCart, resolveCart } from '../../features/cart/cart';
import {
  getPaymentProvider,
  enabledMethods,
  defaultMethod,
  isMethodAvailable,
  type PaymentMethod,
  STRIPE_CHECKOUT_TTL_SECONDS,
  OPENNODE_CHECKOUT_TTL_SECONDS,
  RESERVATION_EXPIRY_GRACE_SECONDS,
} from '../../features/payments';
import { getStoreSettings } from '../../features/settings/db';
import { createConfigRatesCalculator } from '../../features/shipping/calculator';
import { getConfig } from '../../config';
import {
  reserveInventory,
  releaseInventoryReservation,
  type ReservationItem,
} from '../../features/orders/reservations';
import { mintLightningOrder } from '../../features/payments/lightning-provider';
import { getLightningBackend } from '../../features/payments/lightning';

export const prerender = false;

interface ShipTo {
  email: string;
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postal: string;
  country: string;
}

/** Validate an agent-supplied `ship_to` object; null if incomplete/invalid. */
function parseShipTo(raw: unknown): ShipTo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).trim() : '');
  const email = s('email');
  const name = s('name');
  const line1 = s('line1');
  const city = s('city');
  const postal = s('postal');
  const country = s('country').toUpperCase();
  if (!/.+@.+\..+/.test(email) || !name || !line1 || !city || !postal || country.length !== 2) {
    return null;
  }
  return { email, name, line1, line2: s('line2') || null, city, state: s('state') || null, postal, country };
}

interface LineDraft {
  product: Product;
  qty: number;
  name: string; // composed: product + variant + extras
  unitPriceCents: number; // variant/base + extras
  availableStock: number; // variant stock if a variant, else product stock
  variantId: number | null;
}

const MAX_CHECKOUT_LINES = 50;
const MAX_JSON_BYTES = 64 * 1024;

const reservationItems = (lines: LineDraft[]): ReservationItem[] =>
  lines.map((line) => ({
    productId: line.product.id,
    variantId: line.variantId,
    name: line.name,
    priceCents: line.unitPriceCents,
    quantity: line.qty,
  }));

function reservationTtlSeconds(method: PaymentMethod): number {
  if (method === 'lightning') {
    return (
      getConfig().payments.lightning.invoiceExpiryMinutes * 60 +
      RESERVATION_EXPIRY_GRACE_SECONDS
    );
  }
  const providerTtl =
    method === 'opennode' ? OPENNODE_CHECKOUT_TTL_SECONDS : STRIPE_CHECKOUT_TTL_SECONDS;
  return providerTtl + RESERVATION_EXPIRY_GRACE_SECONDS;
}

// Open CORS so browser-based agents/tools can POST cross-origin.
const CHECKOUT_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const cjson = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CHECKOUT_CORS },
  });

export const OPTIONS: APIRoute = () => new Response(null, { status: 204, headers: CHECKOUT_CORS });

// GET /api/checkout — discovery: which payment methods this store offers, so an
// agent can choose one to pass as { method } below.
export const GET: APIRoute = async () => {
  const settings = await getStoreSettings(env.DB);
  const methods = enabledMethods(settings);
  return cjson({ available_methods: methods, default: methods[0] });
};

// Creates a checkout session for either a single "Buy now" product (when
// product_id is posted) or the whole cart. Pricing + stock come from D1.
// JSON Content-Type → the programmatic (agent) path: returns { checkout_url }
// instead of a redirect. Form posts keep the existing browser flow below.
export const POST: APIRoute = async ({ request, cookies, url, redirect }) => {
  if ((request.headers.get('content-type') ?? '').includes('application/json')) {
    return handleJsonCheckout(request, url);
  }

  const form = await request.formData();
  const origin = url.origin;

  let lines: LineDraft[] = [];
  let cancelUrl = `${origin}/`;
  // Where to send the shopper if a stock check fails (cart, or the product).
  let errorPath = '/cart';

  const productId = Number(form.get('product_id'));
  if (Number.isInteger(productId) && productId > 0) {
    const product = await getProduct(env.DB, productId);
    if (!product || !product.active) {
      return new Response('Product unavailable', { status: 404 });
    }
    // Express "Buy now" — resolve variant + extras right here so it checks out
    // WITHOUT the cart (works even when the cart is switched off).
    const variants = await listVariants(env.DB, productId);
    let variant: ProductVariant | null = null;
    if (variants.length > 0) {
      variant = variants.find((v) => v.id === Number(form.get('variant_id'))) ?? null;
      if (!variant) {
        const label = product.variant_label || 'option';
        return redirect(
          `/product/${product.slug}?error=${encodeURIComponent(`Please choose a ${label}.`)}`,
          303,
        );
      }
    }
    const extraIds = form
      .getAll('extra')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    const extras = extraIds.length ? await getExtrasByIds(env.DB, productId, extraIds) : [];
    lines = [
      {
        product,
        qty: 1,
        name:
          product.name +
          (variant ? ` — ${variant.label}` : '') +
          (extras.length ? ` (${extras.map((e) => e.label).join(', ')})` : ''),
        unitPriceCents: lineUnitPriceCents(product.price_cents, variant, extras),
        availableStock: variant ? variant.stock : product.stock,
        variantId: variant?.id ?? null,
      },
    ];
    cancelUrl = `${origin}/product/${product.slug}?canceled=1`;
    errorPath = `/product/${product.slug}`;
  } else {
    const { lines: cartLines } = await resolveCart(env.DB, readCart(cookies));
    lines = cartLines.map((l) => ({
      product: l.product,
      qty: l.qty,
      // Compose a descriptive name: "Tee — Large (Gift wrap)".
      name:
        l.product.name +
        (l.variant ? ` — ${l.variant.label}` : '') +
        (l.extras.length ? ` (${l.extras.map((e) => e.label).join(', ')})` : ''),
      unitPriceCents: l.unitPriceCents,
      availableStock: l.availableStock,
      variantId: l.variant?.id ?? null,
    }));
    cancelUrl = `${origin}/cart?canceled=1`;
  }

  if (lines.length === 0) return redirect('/cart', 303);

  // Don't oversell — check the variant's stock (or the product's), not the base.
  const short = lines.find((l) => l.availableStock < l.qty);
  if (short) {
    const msg =
      short.availableStock <= 0
        ? `${short.name} is sold out.`
        : `Only ${short.availableStock} of ${short.name} left — please adjust your cart.`;
    return redirect(`${errorPath}?error=${encodeURIComponent(msg)}`, 303);
  }

  // The buyer picks a rail on the cart page (method buttons). An explicitly-chosen
  // real rail that isn't configured → setup instructions (the cart links there too,
  // this guards a crafted POST). Otherwise resolve to a usable method (demo always).
  const requestedRaw = String(form.get('method') ?? '').trim();
  const requested = requestedRaw as PaymentMethod;
  const settings = await getStoreSettings(env.DB);
  if (
    requestedRaw &&
    requestedRaw !== 'demo' &&
    (['stripe', 'lightning', 'opennode'] as string[]).includes(requestedRaw) &&
    !isMethodAvailable(requested, settings)
  ) {
    return redirect(`/payment-setup?method=${encodeURIComponent(requestedRaw)}`, 303);
  }
  const available = enabledMethods(settings);
  // No method enabled → no checkout. Bounce back to the cart (which says so).
  if (available.length === 0) return redirect('/cart', 303);
  // Cart checkout passes an explicit method (the picker buttons). Express buy-now
  // passes none → use the store's default (available[0] — the default rail first).
  const selected: PaymentMethod =
    (available.includes(requested) ? requested : available[0]) ?? defaultMethod(settings);

  const cfg = getConfig();

  // Lightning + shipping enabled: we must collect the address before we can total
  // the order (zone-accurate shipping), so route to the own-checkout page. Carry the
  // buy-now product + variant/extras so it prices the same line. Stripe & OpenNode
  // collect/handle shipping on their own hosted page, so they continue below.
  if (selected === 'lightning' && (settings.shippingEnabled ?? cfg.shipping.enabled)) {
    if (Number.isInteger(productId) && productId > 0) {
      const params = new URLSearchParams({ product_id: String(productId) });
      const vid = form.get('variant_id');
      if (vid) params.set('variant_id', String(vid));
      for (const ex of form.getAll('extra')) params.append('extra', String(ex));
      return redirect(`/checkout?${params}`, 303);
    }
    return redirect('/checkout', 303);
  }

  const provider = await getPaymentProvider(selected);
  // Single store currency: charge every line in it (Stripe can't mix currencies
  // in one session). New products already default to this; legacy rows are coerced.
  const storeCurrency = cfg.currency;

  // Shipping (when enabled): rates come from the shared zone calculator. Stripe
  // Checkout shows a STATIC list (it collects the address itself, after this), so
  // it gets the primary zone's options; zone-accurate per-address shipping is the
  // own-checkout (Lightning) path's job — Stripe can't recompute mid-session.
  const subtotalCents = lines.reduce((s, l) => s + l.unitPriceCents * l.qty, 0);
  const shipCalc = createConfigRatesCalculator(cfg.shipping);
  // The shopper pre-selects a destination on the cart (defaulted, editable), so
  // Stripe gets that zone's rates instead of always the first zone's. Stripe still
  // collects + confirms the full address on its page; this just sets which rates
  // it shows. Falls back to the first zone's country (e.g. buy-now, no selector).
  const selectedCountry = (form.get('country') ?? '').toString().trim().toUpperCase();
  const shipCountry =
    selectedCountry.length === 2 ? selectedCountry : (cfg.shipping.zones[0]?.countries[0] ?? 'US');
  const shipping = (settings.shippingEnabled ?? cfg.shipping.enabled)
    ? {
        addressCountries: shipCalc.allowedCountries(),
        options: shipCalc.optionsFor({ subtotalCents, country: shipCountry }),
      }
    : undefined;

  // Pre-generate the order's public token here so success_url can point straight
  // at the confirmation page. The webhook stores this same id on the order.
  const publicId = crypto.randomUUID();
  const items = reservationItems(lines);
  const reserved =
    selected === 'demo' ||
    (await reserveInventory(env.DB, publicId, items, reservationTtlSeconds(selected), selected));
  if (!reserved) {
    return redirect(
      `${errorPath}?error=${encodeURIComponent('Some inventory just sold out — please review your cart.')}`,
      303,
    );
  }

  let checkoutUrl: string;
  try {
    const result = await provider.createCheckout({
      lineItems: lines.map((l) => ({
        name: l.name,
        amountCents: l.unitPriceCents,
        currency: storeCurrency,
        quantity: l.qty,
        // Same image/placeholder resolution as the storefront, made absolute so
        // Stripe can fetch it (won't render from localhost).
        imageUrl: `${origin}${productImageUrl(l.product.image_key)}`,
      })),
      successUrl: `${origin}/order/${publicId}`,
      // Returning from a hosted checkout does not make that session unpayable,
      // so inventory remains held until its verified expiry/failure webhook.
      cancelUrl,
      shipping,
      allowPromotionCodes: settings.discountsEnabled ?? cfg.discounts.enabled,
      automaticTax: settings.taxEnabled ?? cfg.tax.enabled,
      orderItemsJson: JSON.stringify(
        lines.map((l) => ({ id: l.product.id, q: l.qty, n: l.name, p: l.unitPriceCents, v: l.variantId })),
      ),
      // Provider metadata stays bounded; the cart snapshot is held in D1.
      metadata: {
        public_id: publicId,
        ...(selected !== 'demo' && { reservation_id: publicId }),
      },
    });
    checkoutUrl = result.url;
  } catch (error) {
    if (selected !== 'demo') await releaseInventoryReservation(env.DB, publicId);
    throw error;
  }

  return Response.redirect(checkoutUrl, 303);
};

/**
 * Programmatic checkout for agents/tools. Body:
 *   { items: [{ slug, quantity, variant_id?, extras?: number[] }], method? }
 * `variant_id` is required for products that have a variant group; `extras` are
 * optional add-on ids — both come from the catalog (GET /api/products/:slug).
 * Resolves slugs → priced lines (variant/extra-aware), validates stock, creates a
 * hosted checkout session, and returns { checkout_url } as JSON — the agent hands
 * that URL to the human to pay (honest given agentic-payment standards aren't
 * settled). Reuses the same createCheckout() as the browser flow, so
 * shipping/tax/discounts behave the same.
 */
async function handleJsonCheckout(request: Request, url: URL): Promise<Response> {
  const origin = url.origin;

  // Early reject on the declared size, then enforce the cap on the bytes we
  // actually read — a missing/lying content-length header can't slip past.
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    return cjson({ error: 'Checkout body is too large.' }, 413);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return cjson({ error: 'Invalid request body.' }, 400);
  }
  if (new TextEncoder().encode(raw).length > MAX_JSON_BYTES) {
    return cjson({ error: 'Checkout body is too large.' }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return cjson({ error: 'Invalid JSON body.' }, 400);
  }
  const rawItems = (body as { items?: unknown })?.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return cjson({ error: 'Body must be { "items": [{ "slug": string, "quantity": number }] }.' }, 400);
  }
  if (rawItems.length > MAX_CHECKOUT_LINES) {
    return cjson({ error: `A checkout can contain at most ${MAX_CHECKOUT_LINES} lines.` }, 400);
  }

  // Optional { method } selects the rail; default = the store's default (first
  // available). Must be one the store actually offers.
  const jsonSettings = await getStoreSettings(env.DB);
  const available = enabledMethods(jsonSettings);
  if (available.length === 0) {
    return cjson({ error: 'This store is not accepting payments right now.' }, 503);
  }
  const requested =
    typeof (body as { method?: unknown }).method === 'string'
      ? ((body as { method: string }).method.trim() as PaymentMethod)
      : undefined;
  if (requested && !available.includes(requested)) {
    return cjson({ error: `Unsupported payment method "${requested}".`, available_methods: available }, 400);
  }
  const method: PaymentMethod = requested ?? available[0] ?? defaultMethod(jsonSettings);

  const cfg = getConfig();
  const shippingOn = jsonSettings.shippingEnabled ?? cfg.shipping.enabled;

  // Resolve each { slug, quantity, variant_id?, extras? } → a priced line,
  // validating active + variant choice + stock. Variant/extra ids come from the
  // catalog (GET /api/products/:slug).
  interface AgentLine extends LineDraft {
    variant: ProductVariant | null;
    extras: ProductExtra[];
  }
  const lines: AgentLine[] = [];
  for (const raw of rawItems) {
    const r = raw as { slug?: unknown; quantity?: unknown; variant_id?: unknown; extras?: unknown };
    const slug = typeof r.slug === 'string' ? r.slug.trim() : '';
    const qty = Number(r.quantity);
    if (!slug) return cjson({ error: 'Each item needs a "slug".' }, 400);
    if (!Number.isInteger(qty) || qty < 1) return cjson({ error: `Invalid quantity for "${slug}".` }, 400);

    const product = await getProductBySlug(env.DB, slug);
    if (!product || !product.active) return cjson({ error: `Product not found: ${slug}` }, 404);

    // Variant: required when the product has any. Validate it belongs + is active.
    const variants = await listVariants(env.DB, product.id);
    let variant: ProductVariant | null = null;
    if (variants.length > 0) {
      const wanted = Number(r.variant_id);
      variant = variants.find((v) => v.id === wanted) ?? null;
      if (!variant) {
        return cjson(
          {
            error: `"${slug}" requires a valid "variant_id" (${product.variant_label || 'option'}).`,
            slug,
            variants: variants.map((v) => ({ id: v.id, label: v.label, in_stock: v.stock > 0 })),
          },
          400,
        );
      }
    }

    // Extras: keep the valid, active add-ons that belong to the product.
    const wantExtras = Array.isArray(r.extras)
      ? r.extras.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    const extras = wantExtras.length ? await getExtrasByIds(env.DB, product.id, wantExtras) : [];

    const availableStock = variant ? variant.stock : product.stock;
    if (availableStock < qty) {
      const label = variant ? `${product.name} — ${variant.label}` : product.name;
      return cjson(
        { error: availableStock <= 0 ? `${label} is sold out.` : `Only ${availableStock} of ${label} in stock.`, slug, available: availableStock },
        409,
      );
    }

    lines.push({
      product,
      qty,
      name:
        product.name +
        (variant ? ` — ${variant.label}` : '') +
        (extras.length ? ` (${extras.map((e) => e.label).join(', ')})` : ''),
      unitPriceCents: lineUnitPriceCents(product.price_cents, variant, extras),
      availableStock,
      variantId: variant?.id ?? null,
      variant,
      extras,
    });
  }

  const storeCurrency = cfg.currency;
  const subtotalCents = lines.reduce((s, l) => s + l.unitPriceCents * l.qty, 0);
  const shipCalc = createConfigRatesCalculator(cfg.shipping);
  const shipCountry = cfg.shipping.zones[0]?.countries[0] ?? 'US';
  const shipping = shippingOn
    ? { addressCountries: shipCalc.allowedCountries(), options: shipCalc.optionsFor({ subtotalCents, country: shipCountry }) }
    : undefined;

  // Lightning + shipping: the agent supplies a `ship_to` address (the JSON API has
  // no interactive step). We price shipping for that country, capture the address,
  // and mint an invoice whose total includes shipping — mirroring the /checkout page.
  if (method === 'lightning' && shippingOn) {
    const shipTo = parseShipTo((body as { ship_to?: unknown }).ship_to);
    if (!shipTo) {
      return cjson(
        {
          error: 'A shipped Lightning order needs a "ship_to" address: { email, name, line1, city, postal, country }.',
          available_methods: available,
        },
        400,
      );
    }
    const shipOptions = shipCalc.optionsFor({ subtotalCents, country: shipTo.country });
    if (shipOptions.length === 0) {
      return cjson({ error: `This store does not ship to ${shipTo.country}.` }, 409);
    }
    const wantLabel =
      typeof (body as { shipping_label?: unknown }).shipping_label === 'string'
        ? (body as { shipping_label: string }).shipping_label
        : null;
    const chosen = wantLabel ? shipOptions.find((o) => o.label === wantLabel) : shipOptions[0];
    if (!chosen) {
      return cjson(
        {
          error: `Unknown shipping_label "${wantLabel}".`,
          shipping_options: shipOptions.map((o) => ({ label: o.label, amount_cents: o.amountCents })),
        },
        400,
      );
    }
    const lnPublicId = crypto.randomUUID();
    const lnReserved = await reserveInventory(
      env.DB,
      lnPublicId,
      reservationItems(lines),
      reservationTtlSeconds('lightning'),
      'lightning',
    );
    if (!lnReserved) return cjson({ error: 'Some inventory just sold out. Refresh the catalog and retry.' }, 409);
    try {
      const minted = await mintLightningOrder(env.DB, await getLightningBackend(), {
        origin,
        publicId: lnPublicId,
        currency: storeCurrency,
        subtotalCents,
        shippingCents: chosen.amountCents,
        itemsJson: JSON.stringify(
          lines.map((l) => ({ id: l.product.id, v: l.variantId, q: l.qty, n: l.name, p: l.unitPriceCents })),
        ),
        email: shipTo.email,
        shippingAddress: {
          name: shipTo.name,
          line1: shipTo.line1,
          line2: shipTo.line2,
          city: shipTo.city,
          state: shipTo.state,
          postal: shipTo.postal,
          country: shipTo.country,
        },
        reservationId: lnPublicId,
      });
      return cjson({
        method,
        available_methods: available,
        flow: 'invoice',
        checkout_url: minted.payUrl,
        lightning: {
          invoice: minted.bolt11,
          amount_sat: minted.amountSat,
          payment_hash: minted.paymentHash,
          expires_at: minted.expiresAt,
        },
        order_public_id: lnPublicId,
        currency: storeCurrency.toUpperCase(),
        subtotal_cents: subtotalCents,
        shipping_cents: chosen.amountCents,
        shipping_label: chosen.label,
        total_cents: subtotalCents + chosen.amountCents,
        ship_to: shipTo,
        items: lines.map((l) => ({
          slug: l.product.slug,
          name: l.name,
          quantity: l.qty,
          variant: l.variant ? { id: l.variant.id, label: l.variant.label } : null,
          extras: l.extras.map((e) => ({ id: e.id, label: e.label })),
          unit_price_cents: l.unitPriceCents,
          line_total_cents: l.unitPriceCents * l.qty,
        })),
        note: 'Pay the BOLT11 `lightning.invoice` from any Lightning wallet — the total includes shipping, and the order captures your ship_to address. Settlement is confirmed by the webhook.',
      });
    } catch (error) {
      await releaseInventoryReservation(env.DB, lnPublicId);
      throw error;
    }
  }

  const publicId = crypto.randomUUID();
  const provider = await getPaymentProvider(method);
  const items = reservationItems(lines);
  const reserved =
    method === 'demo' ||
    (await reserveInventory(env.DB, publicId, items, reservationTtlSeconds(method), method));
  if (!reserved) return cjson({ error: 'Some inventory just sold out. Refresh the catalog and retry.' }, 409);

  let result;
  try {
    result = await provider.createCheckout({
      lineItems: lines.map((l) => ({
        name: l.name,
        amountCents: l.unitPriceCents,
        currency: storeCurrency,
        quantity: l.qty,
        imageUrl: `${origin}${productImageUrl(l.product.image_key)}`,
      })),
      successUrl: `${origin}/order/${publicId}`,
      cancelUrl: `${origin}/`,
      shipping,
      allowPromotionCodes: jsonSettings.discountsEnabled ?? cfg.discounts.enabled,
      automaticTax: jsonSettings.taxEnabled ?? cfg.tax.enabled,
      orderItemsJson: JSON.stringify(
        lines.map((l) => ({ id: l.product.id, q: l.qty, n: l.name, p: l.unitPriceCents, v: l.variantId })),
      ),
      metadata: {
        public_id: publicId,
        ...(method !== 'demo' && { reservation_id: publicId }),
      },
    });
  } catch (error) {
    if (method !== 'demo') await releaseInventoryReservation(env.DB, publicId);
    throw error;
  }

  // Lightning: surface the BOLT11 invoice so an agent with a wallet can pay it
  // directly (no human, no /pay page). Settlement is confirmed by the existing
  // webhook → the order is recorded. Hosted providers expose checkout_url only.
  const ln = result.lightning;
  return cjson({
    method, // the rail used: 'stripe' | 'lightning' | 'opennode'
    available_methods: available, // what else this store offers
    flow: ln ? 'invoice' : 'redirect',
    checkout_url: result.url, // human fallback (QR page for Lightning, hosted page otherwise)
    ...(ln && {
      lightning: {
        invoice: ln.invoice,
        amount_sat: ln.amountSat,
        payment_hash: ln.paymentHash,
        expires_at: ln.expiresAt,
      },
    }),
    order_public_id: publicId,
    currency: storeCurrency.toUpperCase(),
    subtotal_cents: subtotalCents,
    items: lines.map((l) => ({
      slug: l.product.slug,
      name: l.name,
      quantity: l.qty,
      variant: l.variant ? { id: l.variant.id, label: l.variant.label } : null,
      extras: l.extras.map((e) => ({ id: e.id, label: e.label })),
      unit_price_cents: l.unitPriceCents,
      line_total_cents: l.unitPriceCents * l.qty,
    })),
    note: ln
      ? 'Pay the BOLT11 `lightning.invoice` from any Lightning wallet — no human needed; the order is recorded once settlement is confirmed. Or open checkout_url for the QR page.'
      : 'Open checkout_url to complete payment. Shipping, tax, and discounts (if enabled) are applied on the hosted checkout page.',
  });
}
