-- Merchant and branch registry foundation. Tenant ownership is explicit and branch IDs are unique per merchant.
CREATE TABLE IF NOT EXISTS merchants (
  id text PRIMARY KEY,
  legal_name text NOT NULL CHECK (length(trim(legal_name)) BETWEEN 2 AND 200),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 2 AND 120),
  country_code char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  status text NOT NULL CHECK (status IN ('pending_review','active','suspended','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS merchant_branches (
  id text NOT NULL,
  merchant_id text NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 2 AND 120),
  city_code text NOT NULL,
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, id),
  CHECK (jsonb_typeof(address) = 'object')
);

CREATE INDEX IF NOT EXISTS merchant_branches_city_status_idx
  ON merchant_branches (city_code, status, merchant_id);
CREATE INDEX IF NOT EXISTS merchants_country_status_idx
  ON merchants (country_code, status);
