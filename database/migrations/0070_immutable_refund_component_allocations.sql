-- Immutable source-component allocations for customer refunds.
-- Each refund must be fully allocated before customer consent or provider submission.
CREATE TABLE customer_payment_adjustment_allocations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  merchant_tenant_id text NOT NULL,
  adjustment_id text NOT NULL,
  order_id text NOT NULL,
  suborder_id text NOT NULL,
  component_kind text NOT NULL CHECK (component_kind IN ('product_subtotal','delivery')),
  source_reference text,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,adjustment_id)
    REFERENCES customer_payment_adjustments(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,order_id)
    REFERENCES customer_orders(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (merchant_tenant_id,order_id,suborder_id)
    REFERENCES merchant_suborders(tenant_id,order_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,adjustment_id,suborder_id,component_kind),
  CHECK (
    (component_kind='product_subtotal' AND source_reference IS NULL) OR
    (component_kind='delivery' AND source_reference IS NOT NULL
      AND length(trim(source_reference)) BETWEEN 1 AND 200)
  ),
  CHECK (amount_minor <= 9000000000000000)
);
CREATE INDEX customer_payment_adjustment_allocations_source_idx
  ON customer_payment_adjustment_allocations
    (tenant_id,order_id,suborder_id,component_kind);

CREATE OR REPLACE FUNCTION validate_customer_payment_adjustment_allocation()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  order_row customer_orders%ROWTYPE;
  adjustment_row customer_payment_adjustments%ROWTYPE;
  suborder_row merchant_suborders%ROWTYPE;
  source_cap numeric;
  already_reserved numeric;
  matching_sources integer;
BEGIN
  -- Serialize every component reservation for an order to prevent concurrent
  -- refund intents from consuming the same merchant/delivery source balance.
  SELECT * INTO order_row
    FROM customer_orders
   WHERE tenant_id=NEW.tenant_id AND id=NEW.order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund_allocation_order_not_found' USING ERRCODE='23503';
  END IF;

  SELECT * INTO adjustment_row
    FROM customer_payment_adjustments
   WHERE tenant_id=NEW.tenant_id AND id=NEW.adjustment_id;
  IF NOT FOUND OR adjustment_row.order_id IS DISTINCT FROM NEW.order_id
     OR adjustment_row.adjustment_direction <> 'refund'
     OR adjustment_row.status <> 'awaiting_customer_consent'
     OR adjustment_row.currency <> NEW.currency
     OR order_row.currency <> NEW.currency THEN
    RAISE EXCEPTION 'refund_allocation_requires_matching_pending_refund' USING ERRCODE='23514';
  END IF;

  SELECT * INTO suborder_row
    FROM merchant_suborders
   WHERE order_id=NEW.order_id AND id=NEW.suborder_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund_allocation_suborder_not_found' USING ERRCODE='23503';
  END IF;
  NEW.merchant_tenant_id := suborder_row.tenant_id;

  IF NEW.component_kind='product_subtotal' THEN
    SELECT COUNT(*), MAX((entry->>'amountMinor')::numeric)
      INTO matching_sources,source_cap
      FROM jsonb_array_elements(
        COALESCE(order_row.metadata->'checkoutPricing'->'suborderProductSubtotals','[]'::jsonb)
      ) entry
     WHERE entry->>'merchantId'=suborder_row.merchant_id
       AND entry->>'branchId'=suborder_row.branch_id
       AND jsonb_typeof(entry->'amountMinor')='number';
    IF matching_sources <> 1 OR source_cap IS NULL THEN
      RAISE EXCEPTION 'refund_product_source_snapshot_missing_or_ambiguous' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT COUNT(*),MAX(total_minor::numeric)
      INTO matching_sources,source_cap
      FROM customer_order_suborder_delivery_quotes
     WHERE tenant_id=NEW.merchant_tenant_id AND order_id=NEW.order_id
       AND suborder_id=NEW.suborder_id AND id=NEW.source_reference
       AND currency=NEW.currency;
    IF matching_sources <> 1 OR source_cap IS NULL THEN
      RAISE EXCEPTION 'refund_delivery_source_quote_missing_or_ambiguous' USING ERRCODE='23514';
    END IF;
  END IF;

  SELECT COALESCE(SUM(a.amount_minor),0)
    INTO already_reserved
    FROM customer_payment_adjustment_allocations a
    JOIN customer_payment_adjustments p
      ON p.tenant_id=a.tenant_id AND p.id=a.adjustment_id
   WHERE a.tenant_id=NEW.tenant_id AND a.order_id=NEW.order_id
     AND a.suborder_id=NEW.suborder_id AND a.component_kind=NEW.component_kind
     AND a.source_reference IS NOT DISTINCT FROM NEW.source_reference
     AND p.status IN ('awaiting_customer_consent','consented','provider_pending','provider_confirmed');
  IF already_reserved + NEW.amount_minor > source_cap THEN
    RAISE EXCEPTION 'refund_component_allocation_exceeds_remaining_source_balance'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER customer_payment_adjustment_allocations_validate
BEFORE INSERT ON customer_payment_adjustment_allocations
FOR EACH ROW EXECUTE FUNCTION validate_customer_payment_adjustment_allocation();

CREATE OR REPLACE FUNCTION validate_customer_payment_adjustment_allocation_total()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  expected_amount bigint;
  allocated_amount numeric;
BEGIN
  SELECT amount_minor INTO expected_amount
    FROM customer_payment_adjustments
   WHERE tenant_id=NEW.tenant_id AND id=NEW.adjustment_id;
  SELECT COALESCE(SUM(amount_minor),0) INTO allocated_amount
    FROM customer_payment_adjustment_allocations
   WHERE tenant_id=NEW.tenant_id AND adjustment_id=NEW.adjustment_id;
  IF allocated_amount <> expected_amount THEN
    RAISE EXCEPTION 'refund_allocation_total_must_equal_adjustment_amount'
      USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END
$function$;
CREATE CONSTRAINT TRIGGER customer_payment_adjustment_allocations_total
AFTER INSERT ON customer_payment_adjustment_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_customer_payment_adjustment_allocation_total();

CREATE OR REPLACE FUNCTION require_refund_allocations_before_consent()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  allocated_amount numeric;
BEGIN
  IF OLD.adjustment_direction='refund'
     AND OLD.status IN ('awaiting_customer_consent','consented')
     AND NEW.status IN ('consented','provider_pending')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT COALESCE(SUM(amount_minor),0) INTO allocated_amount
      FROM customer_payment_adjustment_allocations
     WHERE tenant_id=NEW.tenant_id AND adjustment_id=NEW.id;
    IF allocated_amount <> NEW.amount_minor THEN
      RAISE EXCEPTION 'refund_requires_complete_component_allocation_before_consent'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER customer_payment_adjustments_require_refund_allocations
BEFORE UPDATE OF status ON customer_payment_adjustments
FOR EACH ROW EXECUTE FUNCTION require_refund_allocations_before_consent();

CREATE OR REPLACE FUNCTION prevent_customer_payment_adjustment_allocation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'customer_payment_adjustment_allocations_are_immutable'
    USING ERRCODE='55000';
END
$function$;
CREATE TRIGGER customer_payment_adjustment_allocations_no_update_delete
BEFORE UPDATE OR DELETE ON customer_payment_adjustment_allocations
FOR EACH ROW EXECUTE FUNCTION prevent_customer_payment_adjustment_allocation_mutation();
CREATE TRIGGER customer_payment_adjustment_allocations_no_truncate
BEFORE TRUNCATE ON customer_payment_adjustment_allocations
FOR EACH STATEMENT EXECUTE FUNCTION prevent_customer_payment_adjustment_allocation_mutation();

-- Never let legacy refund jobs without immutable component evidence be submitted
-- after this migration. Their PSP outcome may already be ambiguous, so quarantine
-- them for reconciliation rather than retrying or inventing an allocation.
UPDATE payment_adjustment_submission_outbox o
   SET status='reconciliation_required',
       completed_at=NULL,
       lease_owner=NULL,
       lease_expires_at=NULL,
       last_error_code='REFUND_COMPONENT_ALLOCATION_MISSING',
       updated_at=now()
  FROM customer_payment_adjustments a
 WHERE a.tenant_id=o.tenant_id AND a.id=o.adjustment_id
   AND a.adjustment_direction='refund'
   AND o.status IN ('queued','processing','submitted')
   AND NOT EXISTS (
     SELECT 1
       FROM customer_payment_adjustment_allocations x
      WHERE x.tenant_id=a.tenant_id AND x.adjustment_id=a.id
      GROUP BY x.tenant_id,x.adjustment_id
     HAVING SUM(x.amount_minor)=a.amount_minor
   );
