-- Persist a branch-wide watermark for complete inventory snapshots.
-- Per-variant timestamps alone cannot prove that an entire incoming snapshot is newer:
-- an older partial delivery could otherwise clear variants omitted from that payload.
ALTER TABLE merchant_branches
  ADD COLUMN inventory_snapshot_at timestamptz,
  ADD COLUMN inventory_snapshot_source text
    CHECK (inventory_snapshot_source IS NULL OR inventory_snapshot_source IN
      ('pos','erp','ecommerce','csv','merchant_portal','manual'));

ALTER TABLE merchant_branches
  ADD CONSTRAINT merchant_branches_inventory_snapshot_pair_check
  CHECK ((inventory_snapshot_at IS NULL AND inventory_snapshot_source IS NULL)
      OR (inventory_snapshot_at IS NOT NULL AND inventory_snapshot_source IS NOT NULL));
