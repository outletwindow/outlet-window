-- Recoverable durable inbox leases for at-least-once fulfillment consumers.
ALTER TABLE scheduled_task_inbox
  ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS lease_token text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

-- Any legacy processing row has no recoverable lease; return it to the pending queue.
UPDATE scheduled_task_inbox
SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
    available_at = LEAST(available_at, updated_at), updated_at = now()
WHERE status = 'processing';

ALTER TABLE scheduled_task_inbox
  ADD CONSTRAINT scheduled_task_inbox_lease_state_check
  CHECK (
    (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
  );

CREATE INDEX IF NOT EXISTS scheduled_task_inbox_due_idx
  ON scheduled_task_inbox (available_at, created_at, id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS scheduled_task_inbox_expired_lease_idx
  ON scheduled_task_inbox (lease_expires_at, id)
  WHERE status = 'processing';
