import { formatPrice, getConfig } from '../../config';
import type { Order, OrderItemWithImage, ShippingAddress } from '../orders/db';
import { orderNumber } from '../orders/number';
import { productImageUrl } from '../products/image';
import { carrierName, trackingUrl } from '../orders/tracking';
import type { EmailMessage } from './provider';

/** A 48px product thumbnail cell (absolute URL so email clients can fetch it). */
const thumbCell = (imageKey: string | null, baseUrl: string): string =>
  `<td style="width:60px"><img src="${baseUrl}${productImageUrl(imageKey)}" width="48" height="48" alt="" style="display:block;border-radius:4px;object-fit:cover" /></td>`;

/** One-line-per-field shipping address, blank lines dropped. */
function formatShipAddress(order: Order): string {
  if (!order.ship_address) return '-';
  const a = JSON.parse(order.ship_address) as ShippingAddress;
  return [
    a.name,
    a.line1,
    a.line2,
    [a.city, a.state, a.postal].filter(Boolean).join(', '),
    a.country,
  ]
    .filter(Boolean)
    .join('\n');
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });

/**
 * Build the order-confirmation email for a paid order. `order.email` must be set.
 * `baseUrl` is the site origin (e.g. https://shop.example.com) for the order link.
 */
export function orderConfirmationEmail(
  order: Order,
  items: OrderItemWithImage[],
  baseUrl: string,
): EmailMessage {
  const cfg = getConfig();
  const num = orderNumber(order.id, cfg.orderNumber);
  const money = (cents: number) => formatPrice(cents, order.currency);
  const orderUrl = order.public_id ? `${baseUrl}/order/${order.public_id}` : null;

  const rows = items.map(
    (it) => `${it.name} × ${it.quantity}: ${money(it.price_cents * it.quantity)}`,
  );

  const text = [
    `Thanks for your order!`,
    ``,
    `Order #${num}, ${cfg.storeName}`,
    ``,
    ...rows,
    ...(order.shipping_cents > 0 ? [`Shipping: ${money(order.shipping_cents)}`] : []),
    ...(order.discount_cents > 0 ? [`Discount: -${money(order.discount_cents)}`] : []),
    ...(order.tax_cents > 0 ? [`Tax: ${money(order.tax_cents)}`] : []),
    `Total: ${money(order.amount_total_cents)}`,
    ...(orderUrl ? [``, `View your order: ${orderUrl}`] : []),
  ].join('\n');

  const htmlRows = items
    .map(
      (it) =>
        `<tr>${thumbCell(it.image_key, baseUrl)}<td>${escapeHtml(it.name)} × ${it.quantity}</td><td style="text-align:right">${money(
          it.price_cents * it.quantity,
        )}</td></tr>`,
    )
    .join('');

  const html = `
    <h2>Thanks for your order!</h2>
    <p>Order <strong>#${num}</strong>, ${escapeHtml(cfg.storeName)}</p>
    <table cellpadding="6" style="border-collapse:collapse">
      ${htmlRows}
      ${order.shipping_cents > 0 ? `<tr><td colspan="2">Shipping</td><td style="text-align:right">${money(order.shipping_cents)}</td></tr>` : ''}
      ${order.discount_cents > 0 ? `<tr><td colspan="2">Discount</td><td style="text-align:right">&minus;${money(order.discount_cents)}</td></tr>` : ''}
      ${order.tax_cents > 0 ? `<tr><td colspan="2">Tax</td><td style="text-align:right">${money(order.tax_cents)}</td></tr>` : ''}
      <tr><td colspan="2"><strong>Total</strong></td><td style="text-align:right"><strong>${money(order.amount_total_cents)}</strong></td></tr>
    </table>
    ${orderUrl ? `<p><a href="${orderUrl}">View your order</a></p>` : ''}`;

  return {
    to: order.email!,
    subject: `Your ${cfg.storeName} order #${num}`,
    html,
    text,
  };
}

/**
 * Build the store-owner "new order" notification. `to` is the owner address;
 * `baseUrl` is the site origin for the admin order link.
 */
export function orderNotificationEmail(
  order: Order,
  items: OrderItemWithImage[],
  to: string,
  baseUrl: string,
): EmailMessage {
  const cfg = getConfig();
  const num = orderNumber(order.id, cfg.orderNumber);
  const money = (cents: number) => formatPrice(cents, order.currency);
  const shipText = formatShipAddress(order);
  const adminUrl = `${baseUrl}/admin/orders/${order.id}`;

  const rows = items.map(
    (it) => `${it.name} × ${it.quantity}: ${money(it.price_cents * it.quantity)}`,
  );

  const text = [
    `New order #${num}`,
    ``,
    `Customer: ${order.email ?? '-'}`,
    ``,
    `Ship to:`,
    shipText,
    ``,
    ...rows,
    ...(order.shipping_cents > 0 ? [`Shipping: ${money(order.shipping_cents)}`] : []),
    ...(order.discount_cents > 0 ? [`Discount: -${money(order.discount_cents)}`] : []),
    ...(order.tax_cents > 0 ? [`Tax: ${money(order.tax_cents)}`] : []),
    `Total: ${money(order.amount_total_cents)}`,
    ``,
    `View in admin: ${adminUrl}`,
  ].join('\n');

  const htmlRows = items
    .map(
      (it) =>
        `<tr>${thumbCell(it.image_key, baseUrl)}<td>${escapeHtml(it.name)} × ${it.quantity}</td><td style="text-align:right">${money(
          it.price_cents * it.quantity,
        )}</td></tr>`,
    )
    .join('');

  const html = `
    <h2>New order #${num}</h2>
    <p>Customer: ${escapeHtml(order.email ?? '-')}</p>
    <p><strong>Ship to:</strong><br>${escapeHtml(shipText).replace(/\n/g, '<br>')}</p>
    <table cellpadding="6" style="border-collapse:collapse">
      ${htmlRows}
      ${order.shipping_cents > 0 ? `<tr><td colspan="2">Shipping</td><td style="text-align:right">${money(order.shipping_cents)}</td></tr>` : ''}
      ${order.discount_cents > 0 ? `<tr><td colspan="2">Discount</td><td style="text-align:right">&minus;${money(order.discount_cents)}</td></tr>` : ''}
      ${order.tax_cents > 0 ? `<tr><td colspan="2">Tax</td><td style="text-align:right">${money(order.tax_cents)}</td></tr>` : ''}
      <tr><td colspan="2"><strong>Total</strong></td><td style="text-align:right"><strong>${money(order.amount_total_cents)}</strong></td></tr>
    </table>
    <p><a href="${adminUrl}">View in admin</a></p>`;

  return {
    to,
    subject: `New ${cfg.storeName} order #${num}`,
    html,
    text,
  };
}

/** Build the "your order has shipped" email. `order.email` must be set. */
export function orderShippedEmail(order: Order, baseUrl: string): EmailMessage {
  const cfg = getConfig();
  const num = orderNumber(order.id, cfg.orderNumber);
  const url = trackingUrl(order.tracking_carrier, order.tracking_number);
  const orderUrl = order.public_id ? `${baseUrl}/order/${order.public_id}` : null;

  const text = [
    `Your order #${num} has shipped!`,
    ...(order.tracking_number
      ? [
          ``,
          `Carrier: ${carrierName(order.tracking_carrier)}`,
          `Tracking: ${order.tracking_number}`,
          ...(url ? [`Track it: ${url}`] : []),
        ]
      : []),
    ...(orderUrl ? [``, `View your order: ${orderUrl}`] : []),
  ].join('\n');

  const trackingHtml = order.tracking_number
    ? `<p>Carrier: ${escapeHtml(carrierName(order.tracking_carrier))}<br>Tracking: ${
        url
          ? `<a href="${url}">${escapeHtml(order.tracking_number)}</a>`
          : escapeHtml(order.tracking_number)
      }</p>`
    : '';

  const html = `
    <h2>Your order has shipped!</h2>
    <p>Order <strong>#${num}</strong>, ${escapeHtml(cfg.storeName)}</p>
    ${trackingHtml}
    ${orderUrl ? `<p><a href="${orderUrl}">View your order</a></p>` : ''}`;

  return {
    to: order.email!,
    subject: `Your ${cfg.storeName} order #${num} has shipped`,
    html,
    text,
  };
}
