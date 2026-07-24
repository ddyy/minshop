-- The orders idempotency key holds the payment PROVIDER's session/reference id for
-- every rail (Stripe, Lightning, OpenNode, demo), not just Stripe. Rename the
-- column to match its actual meaning. SQLite's RENAME COLUMN preserves the inline
-- UNIQUE constraint and updates any dependent index references automatically.
ALTER TABLE orders RENAME COLUMN stripe_session_id TO provider_session_id;
