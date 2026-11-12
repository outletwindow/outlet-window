-- Preserve both platform catalog identity and merchant inventory identity.
-- customer_order_items.product_variant_id references the normalized catalog variant,
-- while branch_inventory.product_variant_id is the merchant/POS external variant key.
ALTER TABLE inventory_reservation_lines
  ADD COLUMN IF NOT EXISTS catalog_variant_id text;

UPDATE inventory_reservation_lines
SET catalog_variant_id = product_variant_id
WHERE catalog_variant_id IS NULL;

ALTER TABLE inventory_reservation_lines
  ALTER COLUMN catalog_variant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS inventory_reservation_lines_catalog_variant_idx
  ON inventory_reservation_lines (reservation_id, catalog_variant_id);
