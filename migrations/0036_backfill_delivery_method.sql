-- 0036: pin down what NULL delivery_method means. Data-only.
--
-- 0035 left every pre-existing order NULL and consumers coalesced NULL to
-- 'shipping'. That coalesce made NULL ambiguous the moment settlement gained a
-- genuine unknown state (a Stripe rate lookup that failed can no longer say
-- whether the customer chose pickup) — an unknown coalesced to 'shipping'
-- would silently expose carrier-label purchase on a possible pickup order.
--
-- So: every order that predates pickup support and carries an address IS a
-- delivery order — record it. Afterwards the label path can require
-- delivery_method = 'shipping' exactly, and both NULL (digital/no shipping)
-- and 'unknown' (failed lookup, reconcile by hand) stay ineligible.
UPDATE orders
   SET delivery_method = 'shipping'
 WHERE delivery_method IS NULL AND ship_address IS NOT NULL;
UPDATE pending_payments
   SET delivery_method = 'shipping'
 WHERE delivery_method IS NULL AND ship_address IS NOT NULL;
