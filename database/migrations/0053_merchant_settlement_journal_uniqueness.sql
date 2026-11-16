-- A posted journal is the accounting evidence for exactly one merchant settlement.
-- Reusing it across batches would let the same liability reclassification be approved twice.
CREATE UNIQUE INDEX merchant_settlement_batches_journal_once_idx
  ON merchant_settlement_batches (tenant_id, journal_id)
  WHERE journal_id IS NOT NULL;
