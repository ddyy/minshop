import { formatPrice, getConfig } from '../../config';
import type { Order, OrderItemWithImage, ShippingAddress } from '../orders/db';
import { orderNumber } from '../orders/number';
import { productImageUrl } from '../products/image';
import { carrierName, trackingUrl } from '../orders/tracking';
import type { EmailMessage } from './provider';
import {
  PALETTE,
  emailShell,
  emailButton,
  emailLabel,
  emailItemsTable,
  escapeHtml,
  type TotalRow,
} from './layout';

/** A 48px product thumbnail cell (absolute URL so email clients can fetch it).
 *  `new URL` resolves both an absolute image base (R2 domain) and the relative
 *  /images route against the site origin. */
const thumbCell = (imageKey: string | null, baseUrl: string): string => {
  const src = new URL(productImageUrl(imageKey, getConfig().images.baseUrl), baseUrl).href;
  return `<td style="width:60px;padding:10px 0;border-bottom:1px solid ${PALETTE.line};"><img src="${src}" width="48" height="48" alt="" style="display:block;border-radius:4px;object-fit:cover;background:${PALETTE.paper};" /></td>`;
};

/** Shipping / discount / tax / total, in the order they appear on a receipt. */
function totalRows(order: Order, money: (cents: number) => string): TotalRow[] {
  return [
    ...(order.shipping_cents > 0 ? [{ label: 'Shipping', amount: money(order.shipping_cents) }] : []),
    ...(order.discount_cents > 0
      ? [{ label: 'Discount', amount: `&minus;${money(order.discount_cents)}` }]
      : []),
    ...(order.tax_cents > 0 ? [{ label: 'Tax', amount: money(order.tax_cents) }] : []),
    { label: 'Total', amount: money(order.amount_total_cents), strong: true },
  ];
}

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

/**
 * Build the order-confirmation email for a paid order. `order.email` must be set.
 * `baseUrl` is the site origin (e.g. https://shop.example.com) for the order link.
 */
export function orderConfirmationEmail(
  order: Order,
  items: OrderItemWithImage[],
  baseUrl: string,
  storeName: string,
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
    `Order #${num}, ${storeName}`,
    ``,
    ...rows,
    ...(order.shipping_cents > 0 ? [`Shipping: ${money(order.shipping_cents)}`] : []),
    ...(order.discount_cents > 0 ? [`Discount: -${money(order.discount_cents)}`] : []),
    ...(order.tax_cents > 0 ? [`Tax: ${money(order.tax_cents)}`] : []),
    `Total: ${money(order.amount_total_cents)}`,
    ...(orderUrl ? [``, `View your order: ${orderUrl}`] : []),
  ].join('\n');

  const html = emailShell({
    storeName,
    heading: 'Thanks for your order',
    subheading: `Order #${num} is confirmed. We'll email you again when it ships.`,
    body:
      emailItemsTable(
        items.map((it) => ({
          thumb: thumbCell(it.image_key, baseUrl),
          name: it.name,
          quantity: it.quantity,
          amount: money(it.price_cents * it.quantity),
        })),
        totalRows(order, money),
      ) + (orderUrl ? emailButton(orderUrl, 'View your order') : ''),
    footer: `Questions about this order? Just reply to this email.`,
  });

  return {
    to: order.email!,
    subject: `Your ${storeName} order #${num}`,
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
  storeName: string,
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

  const html = emailShell({
    storeName,
    heading: `New order #${num}`,
    subheading: `${money(order.amount_total_cents)} from ${escapeHtml(order.email ?? 'an unknown address')}`,
    body:
      emailLabel('Ship to') +
      `<p style="margin:0;font-size:14px;line-height:1.6;">${escapeHtml(shipText).replace(/\n/g, '<br>')}</p>` +
      emailItemsTable(
        items.map((it) => ({
          thumb: thumbCell(it.image_key, baseUrl),
          name: it.name,
          quantity: it.quantity,
          amount: money(it.price_cents * it.quantity),
        })),
        totalRows(order, money),
      ) +
      emailButton(adminUrl, 'View in admin'),
  });

  return {
    to,
    subject: `New ${storeName} order #${num}`,
    html,
    text,
  };
}

/** Build the "your order has shipped" email. `order.email` must be set. */
export function orderShippedEmail(order: Order, baseUrl: string, storeName: string): EmailMessage {
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
    ? emailLabel('Tracking') +
      `<p style="margin:0;font-size:14px;line-height:1.6;">
        ${escapeHtml(carrierName(order.tracking_carrier))}<br>
        ${
          url
            ? `<a href="${url}" style="color:${PALETTE.brand};font-weight:600;">${escapeHtml(order.tracking_number)}</a>`
            : escapeHtml(order.tracking_number)
        }
      </p>`
    : '';

  const html = emailShell({
    storeName,
    heading: 'Your order is on its way',
    subheading: `Order #${num} shipped.`,
    body:
      trackingHtml +
      (url
        ? emailButton(url, 'Track your package')
        : orderUrl
          ? emailButton(orderUrl, 'View your order')
          : ''),
    footer: orderUrl && url ? `Order details: <a href="${orderUrl}" style="color:${PALETTE.muted};">${orderUrl}</a>` : undefined,
  });

  return {
    to: order.email!,
    subject: `Your ${storeName} order #${num} has shipped`,
    html,
    text,
  };
}
