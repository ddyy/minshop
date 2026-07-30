-- 0033: the purchased shipping label's document URL. Additive.
--
-- Label purchase (Shippo) fills tracking_carrier/tracking_number like a manual
-- fulfillment would, but the label PDF itself lives at a provider URL the
-- merchant needs again at pack time — losing it after the purchase redirect
-- would mean re-buying a label that was already paid for. Nullable: manually
-- fulfilled orders never have one.
ALTER TABLE orders ADD COLUMN label_url TEXT;
