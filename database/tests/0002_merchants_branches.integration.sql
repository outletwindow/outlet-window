\set ON_ERROR_STOP on
BEGIN;

INSERT INTO merchants (id, legal_name, display_name, country_code, status)
VALUES ('it-merchant-1','Integration Merchant LLC','Integration Merchant','SA','active');

INSERT INTO merchant_branches (id, merchant_id, display_name, city_code, address, status)
VALUES ('it-branch-1','it-merchant-1','Jubail Main','JUB','{"district":"Al Fanateer"}','active');

DO $$
BEGIN
  IF (SELECT count(*) FROM merchant_branches WHERE merchant_id = 'it-merchant-1' AND id = 'it-branch-1') <> 1 THEN
    RAISE EXCEPTION 'merchant branch persistence check failed';
  END IF;
  IF (SELECT count(*) FROM merchant_branches WHERE merchant_id = 'another-merchant' AND id = 'it-branch-1') <> 0 THEN
    RAISE EXCEPTION 'merchant branch tenant isolation check failed';
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO merchant_branches (id, merchant_id, display_name, city_code, status)
    VALUES ('it-orphan-branch','missing-merchant','Orphan Branch','JUB','active');
    RAISE EXCEPTION 'foreign key should reject orphan branch';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END $$;

ROLLBACK;
