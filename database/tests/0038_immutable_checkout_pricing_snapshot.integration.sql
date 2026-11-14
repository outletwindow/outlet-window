\set ON_ERROR_STOP on
BEGIN;
INSERT INTO identities (id,principal_type,status,primary_email,created_at,updated_at)
VALUES ('ow-checkout-snapshot-customer','human','active','checkout-snapshot@example.test',now(),now());

INSERT INTO customer_orders
 (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor,metadata)
VALUES
 ('ow-checkout-snapshot-order','platform','ow-checkout-snapshot-customer','snapshot-key-0001',
  'pending_validation','SAR',13500,
  '{"checkoutPricing":{"currency":"SAR","deliveryQuoteId":"quote-1","deliveryRuleId":"rule-1","deliveryRuleVersion":1,"discountMinor":0,"components":[{"kind":"product_subtotal","amountMinor":12000,"label":"Products"},{"kind":"delivery","amountMinor":1500,"label":"Delivery"}]}}');

-- Non-pricing operational metadata may be updated without changing the snapshot.
UPDATE customer_orders
SET metadata = metadata || '{"supportNote":"customer requested receipt"}'::jsonb
WHERE id = 'ow-checkout-snapshot-order';
DO $$
BEGIN
  BEGIN
    UPDATE customer_orders
    SET metadata = jsonb_set(metadata,'{checkoutPricing,deliveryQuoteId}','\"quote-2\"'::jsonb)
    WHERE id = 'ow-checkout-snapshot-order';
    RAISE EXCEPTION 'checkout pricing snapshot mutation unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE customer_orders
    SET metadata = metadata - 'checkoutPricing'
    WHERE id = 'ow-checkout-snapshot-order';
    RAISE EXCEPTION 'checkout pricing snapshot removal unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM customer_orders
    WHERE id = 'ow-checkout-snapshot-order'
      AND metadata->'checkoutPricing'->>'deliveryQuoteId' = 'quote-1'
      AND metadata->>'supportNote' = 'customer requested receipt'
  ) THEN
    RAISE EXCEPTION 'checkout pricing snapshot or unrelated metadata was not preserved';
  END IF;
END $$;
ROLLBACK;
