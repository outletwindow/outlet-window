-- Customer order edit window and bounded delivery destination snapshots.
-- The five-second edit deadline is derived only from provider-confirmed payment capture.
ALTER TABLE scheduled_order_confirmations
  ADD COLUMN IF NOT EXISTS customer_edit_until timestamptz
  GENERATED ALWAYS AS (payment_captured_at + interval '5 seconds') STORED;

ALTER TABLE customer_orders
  ADD COLUMN IF NOT EXISTS delivery_destination jsonb,
  ADD COLUMN IF NOT EXISTS delivery_quote jsonb,
  ADD COLUMN IF NOT EXISTS delivery_zone_id text,
  ADD COLUMN IF NOT EXISTS delivery_branch_id text;

ALTER TABLE customer_orders
  ADD CONSTRAINT customer_orders_delivery_destination_object_check
  CHECK (delivery_destination IS NULL OR jsonb_typeof(delivery_destination) = 'object'),
  ADD CONSTRAINT customer_orders_delivery_quote_object_check
  CHECK (delivery_quote IS NULL OR jsonb_typeof(delivery_quote) = 'object'),
  ADD CONSTRAINT customer_orders_delivery_zone_nonempty_check
  CHECK (delivery_zone_id IS NULL OR length(trim(delivery_zone_id)) BETWEEN 1 AND 200),
  ADD CONSTRAINT customer_orders_delivery_branch_nonempty_check
  CHECK (delivery_branch_id IS NULL OR length(trim(delivery_branch_id)) BETWEEN 1 AND 200),
  ADD CONSTRAINT customer_orders_delivery_snapshot_pair_check
  CHECK (
    (delivery_destination IS NULL AND delivery_quote IS NULL AND delivery_zone_id IS NULL)
    OR
    (delivery_destination IS NOT NULL AND delivery_quote IS NOT NULL AND delivery_zone_id IS NOT NULL)
  );

CREATE TABLE IF NOT EXISTS customer_order_edit_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  actor_id text NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 200),
  edit_type text NOT NULL CHECK (edit_type IN ('paid_order_content','delivery_destination')),
  occurred_at timestamptz NOT NULL,
  previous_snapshot jsonb NOT NULL CHECK (jsonb_typeof(previous_snapshot) = 'object'),
  next_snapshot jsonb NOT NULL CHECK (jsonb_typeof(next_snapshot) = 'object'),
  quote_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES customer_orders(tenant_id, id) ON DELETE RESTRICT,
  CHECK (quote_reference IS NULL OR length(trim(quote_reference)) BETWEEN 1 AND 240)
);
CREATE INDEX IF NOT EXISTS customer_order_edit_events_order_idx
  ON customer_order_edit_events (tenant_id, order_id, occurred_at DESC, id);

CREATE OR REPLACE FUNCTION prevent_customer_order_edit_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'customer_order_edit_events_are_append_only';
END;
$function$;

DROP TRIGGER IF EXISTS customer_order_edit_events_no_update ON customer_order_edit_events;
CREATE TRIGGER customer_order_edit_events_no_update
BEFORE UPDATE OR DELETE ON customer_order_edit_events
FOR EACH ROW EXECUTE FUNCTION prevent_customer_order_edit_event_mutation();
