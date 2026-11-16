\set ON_ERROR_STOP on
BEGIN;

INSERT INTO identities (id, principal_type, status, display_name, primary_email, primary_phone, created_at, updated_at)
VALUES ('it-user-1','human','active','Integration User','it-user-1@example.test',NULL,now(),now());

INSERT INTO role_assignments (id, principal_id, role, scope, active, valid_from, assigned_by)
VALUES ('it-role-1','it-user-1','merchant_owner','{"merchantId":"merchant-a","branchId":"branch-a"}',true,now(),'integration-test');

INSERT INTO sessions (id, principal_id, created_at, expires_at, last_seen_at, authentication_methods, token_digest, family_id, token_issued_at, idle_expires_at)
VALUES ('it-session-1','it-user-1',now(),now()+interval '1 hour',now(),'["password"]','sha256:test-digest','it-family-1',now(),now()+interval '30 minutes');

DO $$
BEGIN
  IF (SELECT count(*) FROM identities WHERE id = 'it-user-1') <> 1 THEN
    RAISE EXCEPTION 'identity persistence check failed';
  END IF;
  IF (SELECT count(*) FROM role_assignments WHERE principal_id = 'it-user-1' AND scope->>'merchantId' = 'merchant-a' AND scope->>'branchId' = 'branch-a') <> 1 THEN
    RAISE EXCEPTION 'scoped role persistence check failed';
  END IF;
  IF (SELECT count(*) FROM sessions WHERE id = 'it-session-1' AND principal_id = 'it-user-1' AND token_digest = 'sha256:test-digest') <> 1 THEN
    RAISE EXCEPTION 'session persistence/digest check failed';
  END IF;
  IF (SELECT count(*) FROM sessions WHERE principal_id = 'another-user') <> 0 THEN
    RAISE EXCEPTION 'principal isolation check failed';
  END IF;
END $$;

-- A role assignment cannot point at a nonexistent identity.
DO $$
BEGIN
  BEGIN
    INSERT INTO role_assignments (id, principal_id, role, scope, active, valid_from, assigned_by)
    VALUES ('it-role-invalid','missing-user','merchant_owner','{"merchantId":"m"}',true,now(),'integration-test');
    RAISE EXCEPTION 'foreign key should have rejected orphan role';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END $$;

-- A session cannot point at a nonexistent identity.
DO $$
BEGIN
  BEGIN
    INSERT INTO sessions (id, principal_id, created_at, expires_at, last_seen_at, authentication_methods, token_digest, family_id, token_issued_at, idle_expires_at)
    VALUES ('it-session-invalid','missing-user',now(),now()+interval '1 hour',now(),'[]','digest','family',now(),now()+interval '30 minutes');
    RAISE EXCEPTION 'foreign key should have rejected orphan session';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END $$;

ROLLBACK;
