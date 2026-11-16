-- A draft batch cannot reserve or carry a journal before approval.
-- An approved journal is the accounting evidence for exactly one merchant settlement.
ALTER TABLE merchant_settlement_batches
  ADD CONSTRAINT merchant_settlement_batch_journal_status_check
  CHECK (
    (status='draft' AND journal_id IS NULL AND approved_at IS NULL)
    OR (status='approved' AND journal_id IS NOT NULL AND approved_at IS NOT NULL)
  );

CREATE UNIQUE INDEX merchant_settlement_batches_journal_once_idx
  ON merchant_settlement_batches (tenant_id, journal_id)
  WHERE journal_id IS NOT NULL;
