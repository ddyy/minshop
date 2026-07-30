-- 0035: how the order reaches the customer — carrier delivery or local pickup.
-- Additive.
--
-- The shipping snapshot already records WHAT was charged (label text + amount),
-- but the label text is merchant-editable prose: a rate named "Local pickup"
-- priced as a flat delivery rate, or a pickup rate named "Collect", would make
-- text-matching lie. Fulfillment needs the MODE as data — a pickup order must
-- not be offered carrier labels, and a delivery order must not be treated as
-- collectable.
--
-- NULL = placed before this migration (or no shipping at all); consumers treat
-- unknown as 'shipping', which matches every pre-pickup order that exists.
ALTER TABLE orders ADD COLUMN delivery_method TEXT;
ALTER TABLE pending_payments ADD COLUMN delivery_method TEXT;
