-- Immutable audit trail for merchant-issued courier pickup credentials.
-- Plaintext pickup codes are never stored in this table.
CREATE TABLE courier_pickup_code_issuance_audit (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  credential_id text NOT NULL,
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  order_id text NOT NULL,
  suborder_id text NOT NULL,
  actor_id text NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 200),
  actor_role text NOT NULL CHECK (actor_role IN ('merchant_employee','branch_manager','merchant_admin','merchant_owner')),
  action text NOT NULL CHECK (action IN ('issued','reissued')),
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, task_id)
    REFERENCES courier_delivery_tasks(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, task_id, credential_id)
    REFERENCES courier_pickup_code_credentials(tenant_id, task_id, id) ON DELETE RESTRICT
);
CREATE INDEX courier_pickup_code_issuance_audit_task_idx
  ON courier_pickup_code_issuance_audit (tenant_id, task_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION prevent_courier_pickup_code_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'courier_pickup_code_issuance_audit is append-only';
END;
$$;
CREATE TRIGGER courier_pickup_code_issuance_audit_no_update
  BEFORE UPDATE OR DELETE ON courier_pickup_code_issuance_audit
  FOR EACH ROW EXECUTE FUNCTION prevent_courier_pickup_code_audit_mutation();
CREATE TRIGGER courier_pickup_code_issuance_audit_no_truncate
  BEFORE TRUNCATE ON courier_pickup_code_issuance_audit
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_courier_pickup_code_audit_mutation();
