-- Preserve external fulfillment acceptance evidence on the durable inbox row.
ALTER TABLE scheduled_task_inbox
  ADD COLUMN IF NOT EXISTS provider_reference text;

ALTER TABLE scheduled_task_inbox
  ADD CONSTRAINT scheduled_task_inbox_provider_reference_check
  CHECK (
    provider_reference IS NULL OR
    length(trim(provider_reference)) BETWEEN 1 AND 500
  );
