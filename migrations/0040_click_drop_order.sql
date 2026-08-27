-- 0040: remember a Royal Mail Click & Drop order created from Admin so we can
-- deep-link back without re-pushing. Labels are still printed in the C&D
-- dashboard (programmatic label PDF is OBA-only).
ALTER TABLE orders ADD COLUMN click_drop_order_id INTEGER;
ALTER TABLE orders ADD COLUMN click_drop_pushed_at TEXT;
