-- 0030: shipping weight on products and variants, plus an explicit "this product
-- does not ship" flag. Additive; every column is optional or defaulted.
--
-- weight_grams is NULLABLE and means UNKNOWN, not zero. Nothing backfills it,
-- because a guessed weight is worse than no weight: a store that only uses flat
-- rates is unaffected by an unknown weight, whereas a wrong one silently
-- under-charges shipping on every order. Grams are the canonical unit — integers
-- cannot drift, and the Admin display unit (g/kg/oz/lb) converts at the form
-- boundary only.
--
-- A variant's weight overrides its product's; NULL inherits. An explicit 0 is a
-- known weight and must not be read as "inherit".
--
-- requires_shipping defaults to 1 so every existing product keeps behaving
-- exactly as it does today. It exists so digital goods (ebooks, gift cards) can
-- be excluded from weight totals and from the "missing weight" check without
-- overloading a zero weight to mean two different things.
ALTER TABLE products ADD COLUMN weight_grams INTEGER;
ALTER TABLE products ADD COLUMN requires_shipping INTEGER NOT NULL DEFAULT 1;
ALTER TABLE product_variants ADD COLUMN weight_grams INTEGER;
