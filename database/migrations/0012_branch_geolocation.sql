-- Explicit branch geocoordinates for trusted routing-provider requests.
ALTER TABLE merchant_branches
  ADD COLUMN IF NOT EXISTS latitude numeric(9,6),
  ADD COLUMN IF NOT EXISTS longitude numeric(9,6);

ALTER TABLE merchant_branches
  ADD CONSTRAINT merchant_branches_geo_pair_check
    CHECK ((latitude IS NULL AND longitude IS NULL) OR (latitude IS NOT NULL AND longitude IS NOT NULL)),
  ADD CONSTRAINT merchant_branches_latitude_range_check
    CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT merchant_branches_longitude_range_check
    CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);

CREATE INDEX IF NOT EXISTS merchant_branches_geo_lookup_idx
  ON merchant_branches (merchant_id, status)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
