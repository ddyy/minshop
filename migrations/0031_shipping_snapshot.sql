-- 0031: what shipping was actually charged, recorded on the order. Additive.
--
-- orders.shipping_cents (0012) records the amount but not WHICH service was
-- chosen. Under weight pricing that is no longer self-explanatory: "Standard"
-- can be $5 or $25 depending on the band the order fell into, so an amount with
-- no label is an unexplainable line on the order — and recomputing it later from
-- current products would be wrong the moment a weight is edited.
--
-- The pending_payments columns carry the pre-payment snapshot across the
-- asynchronous rails (Lightning and OpenNode settle by webhook, minutes later),
-- mirroring how 0015 carries shipping_cents and the address.
--
-- Both are nullable: orders placed before this migration have no snapshot, and
-- flat-rate stores that never set a weight leave shipping_weight_grams NULL.
ALTER TABLE orders ADD COLUMN shipping_label TEXT;
ALTER TABLE orders ADD COLUMN shipping_weight_grams INTEGER;
ALTER TABLE pending_payments ADD COLUMN shipping_label TEXT;
ALTER TABLE pending_payments ADD COLUMN shipping_weight_grams INTEGER;
