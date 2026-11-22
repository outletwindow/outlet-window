-- Durable courier delivery tasks with tenant isolation and server-verifiable evidence.
-- Pickup codes are represented only by a cryptographic hash; plaintext is never persisted.
ALTER TABLE merchant_suborders
  ADD CONSTRAINT merchant_suborders_tenant_id_unique UNIQUE (tenant_id, id);

CREATE TABLE courier_delivery_tasks (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  suborder_id text NOT NULL,
  courier_id text NOT NULL CHECK (length(trim(courier_id)) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN (
    'offered','accepted','heading_to_pickup','arrived_at_pickup',
    'picked_up','in_transit','arrived_at_dropoff','delivered',
    'declined','cancelled','failed'
  )),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 200),
  offered_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  terminal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, suborder_id)
    REFERENCES merchant_suborders(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK ((status NOT IN ('declined','cancelled','failed')) OR
    (terminal_reason IS NOT NULL AND length(trim(terminal_reason)) > 0)),
  CHECK ((status <> 'picked_up' AND status <> 'in_transit' AND
    status <> 'arrived_at_dropoff' AND status <> 'delivered') OR picked_up_at IS NOT NULL),
  CHECK ((status <> 'delivered') OR delivered_at IS NOT NULL)
);

CREATE INDEX courier_delivery_tasks_courier_status_idx
  ON courier_delivery_tasks (courier_id, status, offered_at DESC);
CREATE INDEX courier_delivery_tasks_tenant_status_idx
  ON courier_delivery_tasks (tenant_id, status, updated_at DESC);

-- A task may have one active pickup-code digest. Rotation/reissue should revoke the
-- previous row before inserting a replacement; consumed codes cannot be reused.
CREATE TABLE courier_pickup_code_credentials (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  code_digest text NOT NULL CHECK (length(trim(code_digest)) BETWEEN 32 AND 256),
  expires_at timestamptz NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id)
    REFERENCES courier_delivery_tasks(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, task_id, id),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX courier_pickup_code_one_live_per_task_idx
  ON courier_pickup_code_credentials (tenant_id, task_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- Immutable evidence metadata; binary media belongs in private object storage.
CREATE TABLE courier_delivery_evidence (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  evidence_type text NOT NULL CHECK (evidence_type IN ('pickup_code_verification','proof_of_delivery')),
  verification_method text NOT NULL CHECK (length(trim(verification_method)) BETWEEN 1 AND 80),
  object_key text,
  content_sha256 text,
  verified_by text NOT NULL CHECK (length(trim(verified_by)) BETWEEN 1 AND 200),
  verified_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id)
    REFERENCES courier_delivery_tasks(tenant_id, id) ON DELETE RESTRICT,
  CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (evidence_type <> 'proof_of_delivery' OR
    (object_key IS NOT NULL AND length(trim(object_key)) > 0 AND content_sha256 IS NOT NULL))
);
CREATE INDEX courier_delivery_evidence_task_idx
  ON courier_delivery_evidence (tenant_id, task_id, verified_at);

CREATE OR REPLACE FUNCTION prevent_courier_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'courier_delivery_evidence is append-only';
END;
$$;
CREATE TRIGGER courier_delivery_evidence_no_update
  BEFORE UPDATE OR DELETE ON courier_delivery_evidence
  FOR EACH ROW EXECUTE FUNCTION prevent_courier_evidence_mutation();

CREATE TABLE courier_delivery_task_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  from_status text,
  to_status text NOT NULL CHECK (to_status IN (
    'offered','accepted','heading_to_pickup','arrived_at_pickup',
    'picked_up','in_transit','arrived_at_dropoff','delivered',
    'declined','cancelled','failed'
  )),
  actor_id text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('courier','dispatcher','system')),
  reason text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id)
    REFERENCES courier_delivery_tasks(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, task_id, sequence)
);
CREATE INDEX courier_delivery_task_events_task_idx
  ON courier_delivery_task_events (tenant_id, task_id, sequence);

CREATE OR REPLACE FUNCTION prevent_courier_task_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'courier_delivery_task_events are append-only';
END;
$$;
CREATE TRIGGER courier_delivery_task_events_no_update
  BEFORE UPDATE OR DELETE ON courier_delivery_task_events
  FOR EACH ROW EXECUTE FUNCTION prevent_courier_task_event_mutation();
