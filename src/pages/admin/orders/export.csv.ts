import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listOrders } from '../../../features/orders/db';
import { getConfig, toMajorUnits, currencyDecimals } from '../../../config';
import { orderNumber } from '../../../features/orders/number';

export const prerender = false;

// Quote a CSV field only when it contains a comma, quote, or newline.
const esc = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// Minor units → major-unit string, scaled by the order's own currency.
const money = (cents: number, currency: string): string =>
  toMajorUnits(cents, currency).toFixed(currencyDecimals(currency));

// GET /admin/orders/export.csv — download all orders as CSV.
export const GET: APIRoute = async () => {
  const orders = await listOrders(env.DB, 100_000);
  const onCfg = getConfig().orderNumber;

  const header = [
    'Order', 'Date', 'Email', 'Status', 'Fulfillment',
    'Subtotal', 'Shipping', 'Discount', 'Tax', 'Total', 'Currency',
    'Carrier', 'Tracking',
  ];
  const rows = orders.map((o) => [
    orderNumber(o.id, onCfg),
    o.created_at,
    o.email ?? '',
    o.status,
    o.fulfillment_status,
    // subtotal = total − shipping − tax + discount
    money(o.amount_total_cents - o.shipping_cents - o.tax_cents + o.discount_cents, o.currency),
    money(o.shipping_cents, o.currency),
    money(o.discount_cents, o.currency),
    money(o.tax_cents, o.currency),
    money(o.amount_total_cents, o.currency),
    o.currency.toUpperCase(),
    o.tracking_carrier ?? '',
    o.tracking_number ?? '',
  ]);

  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="orders.csv"',
    },
  });
};
