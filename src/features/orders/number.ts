export interface OrderNumberConfig {
  offset: number;
  step: number;
  randomStep: number;
}

/**
 * Friendly customer-facing order number, derived deterministically from the
 * internal order id — no storage, no migration, no insert-time race.
 *
 *   number = offset + (id - 1) * step + jitter(id)
 *
 * `offset` sets the start, `step` spaces consecutive orders, and `randomStep`
 * adds a deterministic per-order jitter in [0, randomStep] (via a multiplicative
 * hash of the id) so the numbers don't read as a raw sequential count.
 *
 * Keep `step > randomStep` so the sequence stays strictly increasing and unique.
 * (The number is for humans; the unguessable URL uses the random public_id.)
 */
export function orderNumber(id: number, cfg: OrderNumberConfig): number {
  const jitter =
    cfg.randomStep > 0 ? (Math.imul(id, 2654435761) >>> 0) % (cfg.randomStep + 1) : 0;
  return cfg.offset + (id - 1) * cfg.step + jitter;
}
