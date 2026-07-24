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
  createProduct,
  updateProduct,
  type ProductInput,
} from '../../src/features/products/db';
import { slugify, uniqueSlug } from '../../src/features/products/slug';
import {
  listOrders,
  countOrders,
  getOrder,
  orderStats,
  dailyOrderTotals,
  fulfillOrder,
  listOrderItems,
} from '../../src/features/orders/db';

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

/**
 * minshop MCP server — lets an assistant operate the store (read orders/products,
 * create/update products, fulfill orders) over the same D1 the storefront uses.
 * Stateless tools; the McpAgent Durable Object only holds the MCP session.
 */
export class StoreMcp extends McpAgent<Env, Record<string, never>, Record<string, never>> {
  server = new McpServer({ name: 'minshop', version: '1.0.0' });
  initialState = {};

  async init() {
    const db = this.env.DB;

    // --- reads ---
    this.server.registerTool(
      'list_products',
      {
        description: 'List products (admin view: includes inactive + units sold), one page at a time.',
        inputSchema: {
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().nonnegative().default(0),
        },
      },
      async ({ limit, offset }) =>
        result({
          products: await listAllProducts(db, limit, offset),
          total: await countAllProducts(db),
          limit,
          offset,
        }),
    );

    this.server.registerTool(
      'get_product',
      { description: 'Get one product by id.', inputSchema: { id: z.number().int().positive() } },
      async ({ id }) => {
        const p = await getProduct(db, id);
        return p ? result(p) : result(`No product with id ${id}.`);
      },
    );

    this.server.registerTool(
      'list_orders',
      {
        description: 'List orders, newest first, one page at a time.',
        inputSchema: {
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().nonnegative().default(0),
        },
      },
      async ({ limit, offset }) =>
        result({
          orders: await listOrders(db, limit, 'created_at DESC', offset),
          total: await countOrders(db),
          limit,
          offset,
        }),
    );

    this.server.registerTool(
      'get_order',
      { description: 'Get an order plus its line items, by id.', inputSchema: { id: z.number().int().positive() } },
      async ({ id }) => {
        const order = await getOrder(db, id);
        if (!order) return result(`No order with id ${id}.`);
        return result({ order, items: await listOrderItems(db, id) });
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
        description: 'Create a product. price_cents is integer cents; slug is auto-generated from the name.',
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
        };
        const id = await createProduct(db, input);
        return result({ created: id, slug });
      },
    );

    this.server.registerTool(
      'update_product',
      {
        description: 'Update an existing product. Only the fields you pass change; the rest are kept.',
        inputSchema: {
          id: z.number().int().positive(),
          name: z.string().min(1).optional(),
          price_cents: z.number().int().nonnegative().optional(),
          description: z.string().nullable().optional(),
          stock: z.number().int().nonnegative().optional(),
          currency: z.string().optional(),
          active: z.boolean().optional(),
        },
      },
      async ({ id, name, price_cents, description, stock, currency, active }) => {
        const cur = await getProduct(db, id);
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
        };
        await updateProduct(db, id, input);
        return result({ updated: id });
      },
    );

    this.server.registerTool(
      'fulfill_order',
      {
        description: 'Mark an order fulfilled (shipped), with optional carrier + tracking number.',
        inputSchema: {
          id: z.number().int().positive(),
          carrier: z.string().optional(),
          tracking_number: z.string().optional(),
        },
      },
      async ({ id, carrier, tracking_number }) => {
        const order = await getOrder(db, id);
        if (!order) return result(`No order with id ${id}.`);
        await fulfillOrder(db, id, carrier ?? null, tracking_number ?? null);
        return result({ fulfilled: id });
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
