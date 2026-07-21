-- 0020_order_settlement_claim — atomic, concurrency-safe order settlement.
--
-- A per-invocation token claims an order inside the same D1 batch that writes
-- its items and decrements stock. The legacy default is deliberate: the old
-- Worker may still serve traffic between `migrations apply` and the new deploy,
-- and rows it inserts must be treated as already settled. The new Worker
-- explicitly inserts NULL, then atomically replaces it with its claim token.

ALTER TABLE orders ADD COLUMN settlement_token TEXT DEFAULT 'legacy';
