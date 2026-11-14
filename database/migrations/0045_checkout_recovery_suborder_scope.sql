-- A recovery case may identify only a suborder belonging to its exact parent order.
-- The platform tenant on the parent order differs from the merchant tenant on a suborder,
-- so scope the relationship by the globally unique parent order ID rather than tenant_id.
ALTER TABLE merchant_suborders
  ADD CONSTRAINT merchant_suborders_order_id_id_key UNIQUE (order_id, id);

ALTER TABLE checkout_recovery_cases
  ADD CONSTRAINT checkout_recovery_cases_failed_suborder_scope_fk
  FOREIGN KEY (order_id, failed_suborder_id)
  REFERENCES merchant_suborders (order_id, id)
  ON DELETE RESTRICT;
