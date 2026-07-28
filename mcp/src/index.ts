import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';

// Reuse the storefront's query logic (the db modules import only TYPES from
// workers-types, so they're clean to share across Workers — no duplication).
import {
  listAllProducts,
  countAllProducts,
  getProduct,
  getProductByPublicId,
  getProductBySlug,
  createProduct,
  updateProduct,
  type Product,
  type AdminProduct,
  type ProductInput,
} from '../../src/features/products/db';
import { slugify, uniqueSlug } from '../../src/features/products/slug';
import {
  listOrders,
  countOrders,
  getOrderByPublicId,
  orderStats,
  dailyOrderTotals,
  fulfillOrder,
  listOrderItems,
  type Order,
  type OrderItem,
  type ShippingAddress,
} from '../../src/features/orders/db';
import { listRefunds, type Refund } from '../../src/features/refunds/db';
import {
  parsePublicId,
  parseOrderOrLegacyPublicId,
  publicIdToken,
} from '../../src/features/ids/publicId';
import type { D1Database } from '@cloudflare/workers-types';

async function secureEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash));
}

/** Wrap any value as an MCP text result. */
function result(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Projected DTOs — every tool result goes through one of these so a numeric
// row ID, foreign key, or internal snapshot can never leak into MCP output.
// External `id` is always the prefixed public ID (prod_/ord_/rfnd_…).
// ---------------------------------------------------------------------------

/**
 * A row reaching MCP output without its public ID is a deploy-order bug (the
 * backfill must run before cutover) — fail loudly rather than leak the row ID.
 */
function requirePublicId(publicId: string | null, rowId: number, kind: string): string {
  // The error string is boundary output too — never include the numeric row id.
  void rowId;
  if (!publicId) throw new Error(`a ${kind} row has no public_id — run the backfill`);
  return publicId;
}

function productDto(p: Product) {
  return {
    id: requirePublicId(p.public_id, p.id, 'product'),
    slug: p.slug,
    name: p.name,
    description: p.description,
    price_cents: p.price_cents,
    currency: p.currency,
    stock: p.stock,
    active: p.active === 1,
    variant_label: p.variant_label,
    weight_grams: p.weight_grams,
    requires_shipping: p.requires_shipping === 1,
    created_at: p.created_at,
  };
}

function adminProductDto(p: AdminProduct) {
  return { ...productDto(p), sold: p.sold };
}

/**
 * The displayed order reference: the token portion of `ord_<token>`. Legacy
 * orders (pre-prefix hex32/UUID public IDs) show the public ID itself.
 */
function orderReference(publicId: string): string {
  return publicIdToken(publicId, 'order') ?? publicId;
}

function orderDto(o: Order) {
  const id = requirePublicId(o.public_id, o.id, 'order');
  let shipAddress: ShippingAddress | null = null;
  if (o.ship_address) {
    try {
      shipAddress = JSON.parse(o.ship_address) as ShippingAddress;
    } catch {
      shipAddress = null;
    }
  }
  return {
    id,
    reference: orderReference(id),
    email: o.email,
    amount_total_cents: o.amount_total_cents,
    shipping_cents: o.shipping_cents,
    shipping_label: o.shipping_label,
    discount_cents: o.discount_cents,
    tax_cents: o.tax_cents,
    currency: o.currency,
    status: o.status,
    payment_method: o.payment_method,
    provider_refunded_cents: o.provider_refunded_cents,
    external_refunded_cents: o.external_refunded_cents,
    refunded_cents: o.refunded_cents,
    refund_review_reason: o.refund_review_reason,
    fulfillment_status: o.fulfillment_status,
    tracking_carrier: o.tracking_carrier,
    tracking_number: o.tracking_number,
    fulfilled_at: o.fulfilled_at,
    ship_address: shipAddress,
    created_at: o.created_at,
  };
}

function orderItemDto(i: OrderItem) {
  return { name: i.name, quantity: i.quantity, price_cents: i.price_cents };
}

function refundDto(r: Refund) {
  return {
    id: r.public_id, // preserved legacy UUID or rfnd_… — never the row ID
    amount_cents: r.amount_cents,
    status: r.status,
    kind: r.kind,
    reason: r.reason,
    note: r.note,
    created_at: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Boundary resolution — public-ID (or slug) input → internal row, with clear
// errors. Numeric row IDs are rejected outright, never resolved.
// ---------------------------------------------------------------------------

/** Resolve a `prod_…` public ID or slug (convenience) to a product row. */
async function resolveProduct(db: D1Database, id: string): Promise<Product | null | 'numeric'> {
  const trimmed = id.trim();
  if (/^\d+$/.test(trimmed)) return 'numeric';
  const publicId = parsePublicId(trimmed, 'product');
  if (publicId) return getProductByPublicId(db, publicId);
  return getProductBySlug(db, trimmed);
}

const NUMERIC_PRODUCT_ERROR =
  'Numeric row IDs are not accepted. Pass the prod_… public ID (or the slug).';
const NUMERIC_ORDER_ERROR =
  'Numeric row IDs are not accepted. Pass the ord_… public ID (or a legacy order public ID).';

/**
 * minshop MCP server — lets an assistant operate the store (read orders/products,
 * create/update products, fulfill orders) over the same D1 the storefront uses.
 * Stateless tools; the McpAgent Durable Object only holds the MCP session.
 *
 * Version 2.0.0: breaking identifier change — all tools take and return
 * prefixed public IDs (prod_/ord_/rfnd_…); numeric row IDs are rejected.
 */
export class StoreMcp extends McpAgent<Env, Record<string, never>, Record<string, never>> {
  server = new McpServer({ name: 'minshop', version: '2.0.0' });
  initialState = {};

  async init() {
    const db = this.env.DB;

    // --- reads ---
    this.server.registerTool(
      'list_products',
      {
        description:
          'List products (admin view: includes inactive + units sold), one page at a time. ' +
          'Each product id is its prod_… public ID.',
        inputSchema: {
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().nonnegative().default(0),
        },
      },
      async ({ limit, offset }) =>
        result({
          products: (await listAllProducts(db, limit, offset)).map(adminProductDto),
          total: await countAllProducts(db),
          limit,
          offset,
        }),
    );

    this.server.registerTool(
      'get_product',
      {
        description: 'Get one product by its prod_… public ID, or by slug as a convenience.',
        inputSchema: { id: z.string().min(1).describe('prod_… public ID, or a slug') },
      },
      async ({ id }) => {
        const p = await resolveProduct(db, id);
        if (p === 'numeric') return result(NUMERIC_PRODUCT_ERROR);
        return p ? result(productDto(p)) : result(`No product with id ${id}.`);
      },
    );

    this.server.registerTool(
      'list_orders',
      {
        description:
          'List orders, newest first, one page at a time. Each order id is its ord_… public ID ' +
          '(or a preserved legacy public ID); reference is the customer-facing order reference.',
        inputSchema: {
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().nonnegative().default(0),
        },
      },
      async ({ limit, offset }) =>
        result({
          orders: (await listOrders(db, limit, 'created_at DESC', offset)).map(orderDto),
          total: await countOrders(db),
          limit,
          offset,
        }),
    );

    this.server.registerTool(
      'get_order',
      {
        description:
          'Get an order plus its line items and refund history, by its ord_… public ID (legacy ' +
          'public IDs are also accepted). Refunds are read-only: order.provider_refunded_cents ' +
          'is the total the payment provider confirmed and order.external_refunded_cents is ' +
          'what was recorded by hand; order.refunded_cents is their sum, capped at the order ' +
          'total. Each refund amount_cents is a delta, not a running total, and is negative ' +
          'for a correction.',
        inputSchema: { id: z.string().min(1).describe('ord_… public ID (or legacy public ID)') },
      },
      async ({ id }) => {
        if (/^\d+$/.test(id.trim())) return result(NUMERIC_ORDER_ERROR);
        const publicId = parseOrderOrLegacyPublicId(id, 'order');
        if (!publicId) return result(`Invalid order id ${id} — expected an ord_… public ID.`);
        const order = await getOrderByPublicId(db, publicId);
        if (!order) return result(`No order with id ${id}.`);
        return result({
          order: orderDto(order),
          items: (await listOrderItems(db, order.id)).map(orderItemDto),
          refunds: (await listRefunds(db, order.id)).map(refundDto),
        });
      },
    );

    this.server.registerTool(
      'order_stats',
      { description: 'Store totals: order count, net revenue (cents), refunded (cents).', inputSchema: {} },
      async () => result(await orderStats(db)),
    );

    this.server.registerTool(
      'daily_totals',
      {
        description: 'Orders + net revenue per day for the last N days (UTC).',
        inputSchema: { days: z.number().int().min(1).max(90).default(14) },
      },
      async ({ days }) => result(await dailyOrderTotals(db, days)),
    );

    // --- writes (gated by the bearer auth in the fetch handler) ---
    this.server.registerTool(
      'create_product',
      {
        description:
          'Create a product. price_cents is integer cents; slug is auto-generated from the ' +
          'name. Returns the new prod_… public ID and slug.',
        inputSchema: {
          name: z.string().min(1),
          price_cents: z.number().int().nonnegative(),
          description: z.string().optional(),
          stock: z.number().int().nonnegative().default(0),
          currency: z.string().default('usd'),
          active: z.boolean().default(true),
        },
      },
      async ({ name, price_cents, description, stock, currency, active }) => {
        const slug = await uniqueSlug(db, slugify(name));
        const input: ProductInput = {
          name,
          slug,
          description: description ?? null,
          price_cents,
          currency,
          image_key: null,
          stock,
          active: active ? 1 : 0,
          // Weight is set in Admin (it needs the store's display unit); a new
          // product starts shippable with an unknown weight, which is harmless
          // until a weight-priced rate exists.
          weight_grams: null,
          requires_shipping: 1,
        };
        const rowId = await createProduct(db, input);
        const created = await getProduct(db, rowId);
        return result({ id: requirePublicId(created?.public_id ?? null, rowId, 'product'), slug });
      },
    );

    this.server.registerTool(
      'update_product',
      {
        description:
          'Update an existing product by its prod_… public ID (or slug). Only the fields you ' +
          'pass change; the rest are kept.',
        inputSchema: {
          id: z.string().min(1).describe('prod_… public ID, or a slug'),
          name: z.string().min(1).optional(),
          price_cents: z.number().int().nonnegative().optional(),
          description: z.string().nullable().optional(),
          stock: z.number().int().nonnegative().optional(),
          currency: z.string().optional(),
          active: z.boolean().optional(),
        },
      },
      async ({ id, name, price_cents, description, stock, currency, active }) => {
        const cur = await resolveProduct(db, id);
        if (cur === 'numeric') return result(NUMERIC_PRODUCT_ERROR);
        if (!cur) return result(`No product with id ${id}.`);
        const input: ProductInput = {
          name: name ?? cur.name,
          slug: cur.slug,
          description: description !== undefined ? description : cur.description,
          price_cents: price_cents ?? cur.price_cents,
          currency: currency ?? cur.currency,
          image_key: cur.image_key,
          stock: stock ?? cur.stock,
          active: active !== undefined ? (active ? 1 : 0) : cur.active,
          // Not editable here, but must be carried: updateProduct writes every
          // column, so omitting these would silently clear them.
          weight_grams: cur.weight_grams,
          requires_shipping: cur.requires_shipping,
        };
        await updateProduct(db, cur.id, input);
        return result({ id: requirePublicId(cur.public_id, cur.id, 'product'), slug: cur.slug });
      },
    );

    this.server.registerTool(
      'fulfill_order',
      {
        description:
          'Mark an order fulfilled (shipped) by its ord_… public ID (legacy public IDs are ' +
          'also accepted), with optional carrier + tracking number.',
        inputSchema: {
          id: z.string().min(1).describe('ord_… public ID (or legacy public ID)'),
          carrier: z.string().optional(),
          tracking_number: z.string().optional(),
        },
      },
      async ({ id, carrier, tracking_number }) => {
        if (/^\d+$/.test(id.trim())) return result(NUMERIC_ORDER_ERROR);
        const publicId = parseOrderOrLegacyPublicId(id, 'order');
        if (!publicId) return result(`Invalid order id ${id} — expected an ord_… public ID.`);
        const order = await getOrderByPublicId(db, publicId);
        if (!order) return result(`No order with id ${id}.`);
        await fulfillOrder(db, order.id, carrier ?? null, tracking_number ?? null);
        return result({ fulfilled: publicId, reference: orderReference(publicId) });
      },
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/mcp')) {
      // Bearer-token gate. Fail-closed: no token configured → no access.
      const expected = env.MCP_TOKEN;
      if (!expected) {
        return new Response('MCP not configured: set the MCP_TOKEN secret.', { status: 503 });
      }
      const auth = request.headers.get('Authorization') ?? '';
      if (!(await secureEqual(auth, `Bearer ${expected}`))) {
        return new Response('Unauthorized', { status: 401 });
      }
      return StoreMcp.serve('/mcp', { binding: 'STORE_MCP' }).fetch(request, env, ctx);
    }

    return new Response('minshop MCP server — POST /mcp (streamable HTTP, bearer auth).', {
      status: 404,
    });
  },
} satisfies ExportedHandler<Env>;
