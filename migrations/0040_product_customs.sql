-- Customs fields for international shipping labels (HS code + origin).
-- Used when building LabelProvider customs declarations (TGE / Shippo).
ALTER TABLE products ADD COLUMN hs_code TEXT;
ALTER TABLE products ADD COLUMN country_of_origin TEXT;
ALTER TABLE products ADD COLUMN customs_description TEXT;
