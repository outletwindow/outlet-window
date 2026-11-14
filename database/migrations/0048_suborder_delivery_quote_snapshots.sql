-- Persist one immutable, branch-scoped delivery quote per merchant suborder.
-- Parent orders may contain several branches; the legacy customer_orders.delivery_quote
-- remains a single-branch compatibility snapshot and is not sufficient for multi-branch checkout.
ALTER TABLE merchant_suborders
  ADD CONSTRAINT merchant_suborders_delivery_quote_scope_key
  UNIQUE (tenant_id, order_id, id, merchant_id, branch_id);

ALTER TABLE delivery_pricing_rules
  ADD CONSTRAINT delivery_pricing_rules_quote_scope_key
  UNIQUE (tenant_id, id, version, service_area_id);

CREATE TABLE customer_order_suborder_delivery_quotes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  suborder_id text NOT NULL,
  merchant_id text NOT NULL,
  branch_id text NOT NULL,
  service_area_tenant_id text NOT NULL,
  service_area_id text NOT NULL,
  pricing_rule_id text NOT NULL,
  pricing_rule_version integer NOT NULL CHECK (pricing_rule_version > 0),
  quote_snapshot jsonb NOT NULL CHECK (jsonb_typeof(quote_snapshot) = 'object'),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, order_id, suborder_id, merchant_id, branch_id)
    REFERENCES merchant_suborders (tenant_id, order_id, id, merchant_id, branch_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (service_area_tenant_id, service_area_id)
    REFERENCES delivery_service_areas (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (service_area_tenant_id, pricing_rule_id, pricing_rule_version, service_area_id)
    REFERENCES delivery_pricing_rules (tenant_id, id, version, service_area_id) ON DELETE RESTRICT,
  FOREIGN KEY (service_area_tenant_id, service_area_id, merchant_id, branch_id)
    REFERENCES delivery_service_area_branches (tenant_id, service_area_id, merchant_id, branch_id)
    ON DELETE RESTRICT,
  UNIQUE (tenant_id, order_id, suborder_id),
  UNIQUE (service_area_tenant_id, pricing_rule_id, pricing_rule_version, id),
  CHECK (length(trim(id)) BETWEEN 1 AND 200),
  CHECK (length(trim(order_id)) BETWEEN 1 AND 200),
  CHECK (length(trim(suborder_id)) BETWEEN 1 AND 200),
  CHECK (length(trim(merchant_id)) BETWEEN 1 AND 200),
  CHECK (length(trim(branch_id)) BETWEEN 1 AND 200),
  CHECK (expires_at > created_at),
  CHECK (jsonb_typeof(quote_snapshot->'quoteId') = 'string'
         AND quote_snapshot->>'quoteId' = id),
  CHECK (jsonb_typeof(quote_snapshot->'ruleId') = 'string'
         AND quote_snapshot->>'ruleId' = pricing_rule_id),
  CHECK (jsonb_typeof(quote_snapshot->'ruleVersion') = 'number'
         AND quote_snapshot->>'ruleVersion' = pricing_rule_version::text),
  CHECK (jsonb_typeof(quote_snapshot->'currency') = 'string'
         AND quote_snapshot->>'currency' = currency::text),
  CHECK (jsonb_typeof(quote_snapshot->'totalMinor') = 'number'
         AND quote_snapshot->>'totalMinor' = total_minor::text),
  CHECK (jsonb_typeof(quote_snapshot->'components') = 'array'),
  CHECK (jsonb_typeof(quote_snapshot->'createdAtUtc') = 'string'),
  CHECK (jsonb_typeof(quote_snapshot->'expiresAtUtc') = 'string')
);

CREATE INDEX customer_order_suborder_delivery_quotes_order_idx
  ON customer_order_suborder_delivery_quotes (tenant_id, order_id, suborder_id);

CREATE OR REPLACE FUNCTION prevent_customer_order_suborder_delivery_quote_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'customer_order_suborder_delivery_quotes_are_immutable'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER customer_order_suborder_delivery_quotes_no_update_delete
BEFORE UPDATE OR DELETE ON customer_order_suborder_delivery_quotes
FOR EACH ROW EXECUTE FUNCTION prevent_customer_order_suborder_delivery_quote_mutation();

CREATE OR REPLACE FUNCTION prevent_customer_order_suborder_delivery_quote_truncate()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'customer_order_suborder_delivery_quotes_cannot_be_truncated'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER customer_order_suborder_delivery_quotes_no_truncate
BEFORE TRUNCATE ON customer_order_suborder_delivery_quotes
FOR EACH STATEMENT EXECUTE FUNCTION prevent_customer_order_suborder_delivery_quote_truncate();
