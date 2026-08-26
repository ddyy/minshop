/**
 * Human-facing fulfilment labels for physical merchandise.
 *
 * Storage stays binary (`unfulfilled` | `fulfilled`). Display depends on how
 * the order should leave the shop: local pickup vs postage. Useful for members'
 * clubs and local groups that offer collection alongside shipping.
 */
export function fulfillmentStatusLabel(
  fulfillmentStatus: string,
  deliveryMethod: string | null | undefined,
): string {
  const done = fulfillmentStatus === 'fulfilled';
  if (deliveryMethod === 'pickup') return done ? 'Collected' : 'Ready for collection';
  if (deliveryMethod === 'shipping') return done ? 'Dispatched' : 'Awaiting dispatch';
  return done ? 'Fulfilled' : 'Unfulfilled';
}

/** Primary admin action when marking an outstanding order complete. */
export function fulfillActionLabel(deliveryMethod: string | null | undefined): string {
  if (deliveryMethod === 'pickup') return 'Mark as collected';
  if (deliveryMethod === 'shipping') return 'Mark as dispatched';
  return 'Mark as fulfilled';
}

/** Inverse action after an order has been marked complete. */
export function unfulfillActionLabel(deliveryMethod: string | null | undefined): string {
  if (deliveryMethod === 'pickup') return 'Mark not collected';
  if (deliveryMethod === 'shipping') return 'Mark not dispatched';
  return 'Mark unfulfilled';
}

export function deliveryMethodLabel(deliveryMethod: string | null | undefined): string {
  if (deliveryMethod === 'pickup') return 'Collection';
  if (deliveryMethod === 'shipping') return 'Postage';
  return 'Delivery';
}
