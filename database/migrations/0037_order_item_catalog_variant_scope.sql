-- Enforce that every new order line references the exact published-catalog
-- variant identity belonging to the merchant tenant recorded on its suborder.
-- NOT VALID preserves legacy order history while enforcing all new writes.
ALTER TABLE commerce_catalog_variants
  ADD CONSTRAINT commerce_catalog_variants_tenant_variant_sku_unique
  UNIQUE (tenant_id, id, sku);

ALTER TABLE customer_order_items
  ADD CONSTRAINT customer_order_items_catalog_variant_sku_fk
  FOREIGN KEY (tenant_id, product_variant_id, sku)
  REFERENCES commerce_catalog_variants (tenant_id, id, sku)
  ON DELETE RESTRICT
  NOT VALID;
