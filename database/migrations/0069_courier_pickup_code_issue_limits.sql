-- Durable per-actor pickup-code issuance throttling.
-- Three credentials may be issued per task/actor in a 15-minute window.
-- The fourth request starts a 15-minute cooldown. State is shared across API replicas.
CREATE TABLE courier_pickup_code_issue_limits (
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  actor_id text NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 200),
  window_started_at timestamptz NOT NULL,
  issue_count integer NOT NULL CHECK (issue_count BETWEEN 1 AND 1000000),
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, task_id, actor_id),
  FOREIGN KEY (tenant_id, task_id)
    REFERENCES courier_delivery_tasks(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX courier_pickup_code_issue_limits_blocked_idx
  ON courier_pickup_code_issue_limits (blocked_until)
  WHERE blocked_until IS NOT NULL;
