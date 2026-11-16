-- Keep provider refund events that cannot yet be safely matched out of the
-- generic webhook worker queue until an operator/reconciler resolves them.
ALTER TABLE payment_provider_webhook_events
  DROP CONSTRAINT payment_provider_webhook_events_status_check;
ALTER TABLE payment_provider_webhook_events
  ADD CONSTRAINT payment_provider_webhook_events_status_check
  CHECK (status IN ('received','processing','applied','ignored','failed','reconciliation_required'));

ALTER TABLE payment_provider_webhook_events
  DROP CONSTRAINT payment_provider_webhook_events_check;
ALTER TABLE payment_provider_webhook_events
  ADD CONSTRAINT payment_provider_webhook_events_processing_state_check
  CHECK (
    (status IN ('applied','ignored','failed') AND processed_at IS NOT NULL)
    OR (status IN ('received','processing','reconciliation_required') AND processed_at IS NULL)
  );

CREATE INDEX payment_provider_webhook_events_reconciliation_idx
  ON payment_provider_webhook_events(provider_key,received_at)
  WHERE status='reconciliation_required';
