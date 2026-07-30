-- 0037: identify WHICH purchase attempt owns the row. Additive.
--
-- Status alone cannot fence attempts across time: attempt A can outlive its
-- lease, be discarded, and still complete after the merchant has quoted and
-- claimed attempt B — and a completion keyed only on (order_id, status) would
-- then write A's label into B's row, or fail B's purchase with A's error.
-- Every claim mints a fresh random token; completions must present it. A
-- discarded-and-recreated row can never share a token with a late response.
ALTER TABLE shipping_labels ADD COLUMN claim_token TEXT;
