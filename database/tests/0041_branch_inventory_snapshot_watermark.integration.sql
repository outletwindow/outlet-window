\set ON_ERROR_STOP on
BEGIN;

INSERT INTO merchants (id,legal_name,display_name,country_code,status)
VALUES ('snapshot-merchant','Snapshot Merchant LLC','Snapshot Merchant','SA','active');
INSERT INTO merchant_branches (id,merchant_id,display_name,city_code,status)
VALUES ('snapshot-branch','snapshot-merchant','Main Branch','JUB','active');

UPDATE merchant_branches
SET inventory_snapshot_at='2026-11-14T12:00:00Z', inventory_snapshot_source='pos'
WHERE merchant_id='snapshot-merchant' AND id='snapshot-branch';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM merchant_branches
    WHERE merchant_id='snapshot-merchant' AND id='snapshot-branch'
      AND inventory_snapshot_at='2026-11-14T12:00:00Z'
      AND inventory_snapshot_source='pos'
  ) THEN
    RAISE EXCEPTION 'branch snapshot watermark was not persisted';
  END IF;

  BEGIN
    UPDATE merchant_branches SET inventory_snapshot_source=NULL
    WHERE merchant_id='snapshot-merchant' AND id='snapshot-branch';
    RAISE EXCEPTION 'snapshot timestamp/source pair constraint was not enforced';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE merchant_branches SET inventory_snapshot_source='unknown'
    WHERE merchant_id='snapshot-merchant' AND id='snapshot-branch';
    RAISE EXCEPTION 'snapshot source allowlist was not enforced';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

ROLLBACK;
