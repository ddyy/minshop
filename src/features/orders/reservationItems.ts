import type { Product } from '../products/db.ts';
import type { ReservationItem } from './reservations.ts';
import { entitlementWriterActive } from '../digitalDelivery/rollout.ts';

/**
 * A priced checkout line, before it becomes a reservation snapshot.
 * Owned here rather than in the checkout route so the snapshot builder can be
 * tested directly — it is the single place a digital entitlement crosses from
 * live product state into the immutable record the buyer is owed.
 */
export interface ReservationLine {
  product: Product;
  qty: number;
  name: string; // composed: product + variant + extras
  unitPriceCents: number; // variant/base + extras
  variantId: number | null;
}

export interface LineDraft extends ReservationLine {
  availableStock: number; // variant stock if a variant, else product stock
}

/**
 * Build the reservation snapshot for a set of checkout lines.
 *
 * The entitlement is copied from the product row HERE, before provider handoff,
 * because settlement reloads this snapshot and never re-reads product state: a
 * buyer receives the file that was attached when their checkout began.
 *
 * Gated at release 3 — the fulfillment *compatibility* release — deliberately
 * one release before attachment is enabled. A file attached under release 4
 * survives a rollback in D1, and shoppers keep buying, so release 3 must
 * already write this or those checkouts settle with no entitlement at all.
 */
export const reservationItems = (lines: ReservationLine[]): ReservationItem[] =>
  lines.map((line) => ({
    productId: line.product.id,
    variantId: line.variantId,
    name: line.name,
    priceCents: line.unitPriceCents,
    quantity: line.qty,
    ...(entitlementWriterActive() && line.product.file_key
      ? {
          fileKey: line.product.file_key,
          fileName: line.product.file_name,
          fileMime: line.product.file_mime,
          fileSizeBytes: line.product.file_size_bytes,
        }
      : {}),
  }));
