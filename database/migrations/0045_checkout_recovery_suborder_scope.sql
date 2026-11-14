-- A recovery case may identify only a suborder belonging to the same tenant and parent order.
-- The composite FK prevents recovery records from being misattributed across orders or tenants.
ALTER TABLE checkout_recovery_cases
  ADD CONSTRAINT checkout_recovery_cases_failed_suborder_scope_fk
  FOREIGN KEY (tenant_id, order_id, failed_suborder_id)
  REFERENCES merchant_suborders (tenant_id, order_id, id)
  ON DELETE RESTRICT;
