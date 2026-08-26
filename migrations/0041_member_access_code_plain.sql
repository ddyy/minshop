-- Plaintext member codes for admin visibility (table is admin-only; protect /admin).
-- Legacy rows keep code_hash only; authenticateMemberCode checks both.

ALTER TABLE member_access_codes ADD COLUMN code TEXT;
