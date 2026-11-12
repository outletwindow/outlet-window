\set ON_ERROR_STOP on
BEGIN;
INSERT INTO merchants (id, legal_name, display_name, country_code, status)
VALUES ('geo-merchant','Geo Merchant LLC','Geo Merchant','SA','active');
INSERT INTO merchant_branches
  (id, merchant_id, display_name, city_code, address, status, latitude, longitude)
VALUES
  ('geo-branch','geo-merchant','Geo Branch','JUB','{}','active',27.004600,49.646000);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM merchant_branches
    WHERE merchant_id = 'geo-merchant' AND id = 'geo-branch'
      AND latitude = 27.004600 AND longitude = 49.646000
  ) THEN RAISE EXCEPTION 'branch geolocation persistence failed'; END IF;
  BEGIN
    INSERT INTO merchant_branches
      (id, merchant_id, display_name, city_code, status, latitude)
    VALUES ('geo-half','geo-merchant','Half Geo','JUB','active',27.0);
    RAISE EXCEPTION 'partial branch coordinates unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO merchant_branches
      (id, merchant_id, display_name, city_code, status, latitude, longitude)
    VALUES ('geo-invalid','geo-merchant','Invalid Geo','JUB','active',91,49);
    RAISE EXCEPTION 'out-of-range branch coordinates unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
