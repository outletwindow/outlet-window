-- Offers are independent candidates; an assigned delivery task is created only
-- after one courier wins the acceptance transaction.
CREATE TABLE courier_dispatch_offers (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  suborder_id text NOT NULL,
  courier_id text NOT NULL CHECK (length(trim(courier_id)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','accepted','declined','expired','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  terminal_reason text,
  accepted_task_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, suborder_id) REFERENCES merchant_suborders(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, accepted_task_id) REFERENCES courier_delivery_tasks(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,id),
  CHECK (expires_at > offered_at),
  CHECK (
    (status='offered' AND responded_at IS NULL AND accepted_task_id IS NULL AND terminal_reason IS NULL)
    OR (status='accepted' AND responded_at IS NOT NULL AND accepted_task_id IS NOT NULL AND terminal_reason IS NULL)
    OR (status IN ('declined','cancelled') AND responded_at IS NOT NULL AND accepted_task_id IS NULL AND terminal_reason IS NOT NULL AND length(trim(terminal_reason))>0)
    OR (status='expired' AND responded_at IS NOT NULL AND accepted_task_id IS NULL AND terminal_reason IS NULL)
  )
);
CREATE UNIQUE INDEX courier_dispatch_offer_one_pending_per_courier_idx
 ON courier_dispatch_offers(tenant_id,suborder_id,courier_id) WHERE status='offered';
CREATE UNIQUE INDEX courier_dispatch_offer_one_winner_per_suborder_idx
 ON courier_dispatch_offers(tenant_id,suborder_id) WHERE status='accepted';
CREATE UNIQUE INDEX courier_dispatch_offer_one_task_idx
 ON courier_dispatch_offers(tenant_id,accepted_task_id) WHERE accepted_task_id IS NOT NULL;
CREATE INDEX courier_dispatch_offer_courier_inbox_idx
 ON courier_dispatch_offers(tenant_id,courier_id,expires_at) WHERE status='offered';
CREATE INDEX courier_dispatch_offer_expiry_idx
 ON courier_dispatch_offers(expires_at) WHERE status='offered';

CREATE TABLE courier_dispatch_offer_events (
 id text PRIMARY KEY, tenant_id text NOT NULL, offer_id text NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0),
 from_status text CHECK(from_status IS NULL OR from_status IN ('offered','accepted','declined','expired','cancelled')),
 to_status text NOT NULL CHECK(to_status IN ('offered','accepted','declined','expired','cancelled')),
 actor_id text NOT NULL CHECK(length(trim(actor_id)) BETWEEN 1 AND 200),
 actor_role text NOT NULL CHECK(actor_role IN ('courier','dispatcher','system')),
 reason text, occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,offer_id) REFERENCES courier_dispatch_offers(tenant_id,id) ON DELETE RESTRICT,
 UNIQUE(tenant_id,offer_id,sequence)
);
CREATE INDEX courier_dispatch_offer_events_offer_idx ON courier_dispatch_offer_events(tenant_id,offer_id,sequence);
CREATE OR REPLACE FUNCTION prevent_courier_dispatch_offer_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'courier_dispatch_offer_events are append-only'; END;
$$;
CREATE TRIGGER courier_dispatch_offer_events_no_update
 BEFORE UPDATE OR DELETE ON courier_dispatch_offer_events
 FOR EACH ROW EXECUTE FUNCTION prevent_courier_dispatch_offer_event_mutation();
