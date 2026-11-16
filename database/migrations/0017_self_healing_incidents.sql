CREATE TABLE self_healing_incidents (
  incident_id text PRIMARY KEY,
  service text NOT NULL CHECK (service ~ '^[A-Za-z0-9._:-]{1,120}$'),
  severity text NOT NULL CHECK (severity IN ('transient','dependency_unavailable','stale_lease','invariant_violation','security_violation','data_loss','unknown')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','recovered','approval_required','blocked','failed')),
  automatic_attempt_count integer NOT NULL DEFAULT 0 CHECK (automatic_attempt_count BETWEEN 0 AND 10),
  last_action text CHECK (last_action IS NULL OR last_action IN ('retry_idempotent_job','reclaim_expired_lease','restart_unhealthy_service','manual_review')),
  last_attempt_at timestamptz,
  last_outcome text CHECK (last_outcome IS NULL OR last_outcome IN ('recovered','retry_scheduled','approval_required','blocked','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX self_healing_incidents_open_idx
  ON self_healing_incidents(status, updated_at)
  WHERE status IN ('open','approval_required','failed');

CREATE TABLE self_healing_recovery_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id text NOT NULL REFERENCES self_healing_incidents(incident_id),
  service text NOT NULL,
  action text NOT NULL CHECK (action IN ('retry_idempotent_job','reclaim_expired_lease','restart_unhealthy_service','manual_review')),
  outcome text NOT NULL CHECK (outcome IN ('recovered','retry_scheduled','approval_required','blocked','failed')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z0-9_]{1,100}$'),
  occurred_at timestamptz NOT NULL
);

CREATE INDEX self_healing_recovery_events_recent_idx
  ON self_healing_recovery_events(service, action, occurred_at DESC);
