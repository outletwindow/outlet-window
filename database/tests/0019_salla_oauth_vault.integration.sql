BEGIN;
INSERT INTO salla_oauth_states (state_sha256, tenant_id, integration_id, expires_at)
VALUES (repeat('a',64), 'tenant-salla-test', 'integration-salla-test', now() + interval '5 minutes');
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM salla_oauth_states
    WHERE state_sha256 = repeat('a',64) AND tenant_id = 'tenant-salla-test'
  ) THEN RAISE EXCEPTION 'Salla OAuth state insert failed'; END IF;
END $$;
DELETE FROM salla_oauth_states WHERE state_sha256 = repeat('a',64);
INSERT INTO salla_oauth_tokens
  (tenant_id, integration_id, iv, auth_tag, ciphertext, expires_at)
VALUES
  ('tenant-salla-test', 'integration-salla-test', repeat('b',24), repeat('c',24), 'ciphertext-only', now() + interval '1 hour');
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM salla_oauth_tokens
    WHERE tenant_id = 'tenant-salla-test' AND integration_id = 'integration-salla-test'
      AND ciphertext = 'ciphertext-only'
  ) THEN RAISE EXCEPTION 'Salla OAuth token vault insert failed'; END IF;
END $$;
ROLLBACK;
