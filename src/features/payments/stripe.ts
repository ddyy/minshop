import Stripe from 'stripe';
import type {
  PaymentProvider,
  CreateCheckoutParams,
  CheckoutResult,
  WebhookResult,
} from './provider';
import { STRIPE_CHECKOUT_TTL_SECONDS } from './provider';

// Shipping details have moved across Stripe API versions (session.shipping_details
// → session.collected_information.shipping_details); this is the shape we read.
type ShippingDetails = {
  name?: string | null;
  address?: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
    country?: string | null;
  } | null;
} | null;

/**
 * Stripe adapter for the PaymentProvider port. createFetchHttpClient() is
 * required on Workers (no Node HTTP), and webhook verification must use the
 * async (WebCrypto) path.
 */
export function createStripeProvider(
  secretKey: string,
  webhookSecret: string,
): PaymentProvider {
  const stripe = new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  return {
    async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        // Keep the hosted session within the inventory reservation window.
        expires_at: Math.floor(Date.now() / 1000) + STRIPE_CHECKOUT_TTL_SECONDS,
        line_items: params.lineItems.map((li) => ({
          price_data: {
            currency: li.currency,
            unit_amount: li.amountCents,
            // Stripe Tax requires a tax_behavior on inline prices; 'exclusive' =
            // tax added on top of the listed price (typical for US).
            ...(params.automaticTax && { tax_behavior: 'exclusive' as const }),
            product_data: {
              name: li.name,
              ...(li.imageUrl && { images: [li.imageUrl] }),
            },
          },
          quantity: li.quantity,
        })),
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        ...(params.metadata && { metadata: params.metadata }),
        ...(params.allowPromotionCodes && { allow_promotion_codes: true }),
        ...(params.automaticTax && { automatic_tax: { enabled: true } }),
        ...(params.shipping && {
          shipping_address_collection: {
            allowed_countries:
              params.shipping.addressCountries as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[],
          },
          shipping_options: params.shipping.options.map((o) => ({
            shipping_rate_data: {
              type: 'fixed_amount' as const,
              display_name: o.label,
              fixed_amount: {
                amount: o.amountCents,
                currency: params.lineItems[0]?.currency ?? 'usd',
              },
              ...(params.automaticTax && { tax_behavior: 'exclusive' as const }),
            },
          })),
        }),
      });
      if (!session.url) {
        throw new Error('Stripe did not return a checkout URL');
      }
      return { url: session.url };
    },

    async verifyWebhook(payload: string, headers: Headers): Promise<WebhookResult> {
      const signature = headers.get('stripe-signature');
      if (!signature) {
        throw new Error('Missing stripe-signature header');
      }
      const event = await stripe.webhooks.constructEventAsync(
        payload,
        signature,
        webhookSecret,
      );

      if (
        event.type === 'checkout.session.expired' ||
        event.type === 'checkout.session.async_payment_failed'
      ) {
        return {
          type: event.type,
          releaseReservationId: event.data.object.metadata?.reservation_id ?? undefined,
        };
      }

      // Fulfil on a completed session OR a later async success (delayed methods —
      // bank debits, etc. — fire `completed` while still unpaid, then this event
      // once funds clear). Never treat an `unpaid` session as paid.
      // https://docs.stripe.com/checkout/fulfillment
      if (
        event.type === 'checkout.session.completed' ||
        event.type === 'checkout.session.async_payment_succeeded'
      ) {
        const session = event.data.object;

        // Only record when actually settled: 'paid', or 'no_payment_required'
        // ($0 / 100%-off). 'unpaid' = pending async payment — wait for the
        // async_payment_succeeded event (or async_payment_failed → never).
        if (session.payment_status === 'unpaid') {
          return {
            type: event.type,
            pendingReservationId: session.metadata?.reservation_id ?? undefined,
          };
        }

        // Recover the line snapshot we stashed at checkout, if present.
        let items;
        const raw = session.metadata?.items;
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Array<{
              id: number;
              q: number;
              n: string;
              p: number;
              v?: number | null;
            }>;
            items = parsed.map((x) => ({
              productId: x.id,
              variantId: x.v ?? null,
              name: x.n,
              priceCents: x.p,
              quantity: x.q,
            }));
          } catch {
            // Malformed metadata — record the order header without line items.
          }
        }

        // Shipping: amount charged + collected address (location varies by API
        // version — try the newer `collected_information` first).
        // `total_details.amount_shipping` is the reliable field on completed
        // sessions; `shipping_cost` is often undefined unless expanded.
        const shippingCents =
          session.total_details?.amount_shipping ?? session.shipping_cost?.amount_total ?? 0;
        // Discount applied via a promotion code (0 when none).
        const discountCents = session.total_details?.amount_discount ?? 0;
        // Sales tax / VAT computed by Stripe Tax (0 when off/none).
        const taxCents = session.total_details?.amount_tax ?? 0;
        const sd: ShippingDetails =
          (
            session as unknown as {
              collected_information?: { shipping_details?: ShippingDetails };
            }
          ).collected_information?.shipping_details ??
          (session as unknown as { shipping_details?: ShippingDetails }).shipping_details ??
          null;
        const a = sd?.address;
        const shippingAddress = a
          ? {
              name: sd?.name ?? null,
              line1: a.line1 ?? null,
              line2: a.line2 ?? null,
              city: a.city ?? null,
              state: a.state ?? null,
              postal: a.postal_code ?? null,
              country: a.country ?? null,
            }
          : null;

        return {
          type: event.type,
          order: {
            providerSessionId: session.id,
            publicId: session.metadata?.public_id ?? undefined,
            reservationId: session.metadata?.reservation_id ?? undefined,
            email: session.customer_details?.email ?? null,
            amountTotalCents: session.amount_total ?? 0,
            shippingCents,
            discountCents,
            taxCents,
            shippingAddress,
            currency: session.currency ?? 'usd',
            items,
          },
        };
      }
      return { type: event.type };
    },

    async refund(sessionId: string): Promise<void> {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const pi =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : (session.payment_intent?.id ?? null);
      if (!pi) {
        throw new Error('No payment intent found for this session');
      }
      await stripe.refunds.create({ payment_intent: pi });
    },
  };
}
