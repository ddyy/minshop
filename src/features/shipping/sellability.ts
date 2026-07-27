/**
 * The catalog side of "don't let Admin create a store that can't sell".
 *
 * Saving a weight-only zone while products have no weight would silently stop
 * those sales, so the shipping save runs this count and refuses. One bounded query
 * on a rare write; the product form does the reverse check from state it already
 * has, so ordinary product saves never pay for it.
 */

import type { D1Database } from '@cloudflare/workers-types';

/**
 * Active, shippable products with at least one PURCHASABLE choice whose resolved
 * weight is unknown.
 *
 * Variant inheritance is the subtle part: a variant is only missing a weight when
 * its own value AND its product's are null. Products with no active variants are
 * judged on the product row alone. Drafts and inactive rows are ignored — an
 * unfinished product is not a blocked sale.
 */
const MISSING_WEIGHT_SQL = `
  SELECT COUNT(*) AS n
    FROM products p
   WHERE p.active = 1
     AND p.requires_shipping = 1
     AND (
           (NOT EXISTS (SELECT 1 FROM product_variants v
                         WHERE v.product_id = p.id AND v.active = 1)
            AND p.weight_grams IS NULL)
        OR EXISTS (SELECT 1 FROM product_variants v
                    WHERE v.product_id = p.id AND v.active = 1
                      AND COALESCE(v.weight_grams, p.weight_grams) IS NULL)
         )`;

export async function countProductsMissingWeight(db: D1Database): Promise<number> {
  const row = await db.prepare(MISSING_WEIGHT_SQL).first<{ n: number }>();
  return row?.n ?? 0;
}

/** A few names for the error message, so the merchant knows where to start. */
export async function sampleProductsMissingWeight(
  db: D1Database,
  limit = 5,
): Promise<string[]> {
  const { results } = await db
    .prepare(`${MISSING_WEIGHT_SQL.replace('COUNT(*) AS n', 'p.name')} ORDER BY p.name LIMIT ?`)
    .bind(limit)
    .all<{ name: string }>();
  return (results ?? []).map((r) => r.name);
}
