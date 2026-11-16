\set ON_ERROR_STOP on
BEGIN;
INSERT INTO audit_events (
 id,schema_version,event_type,category,occurred_at,actor_id,actor_type,action,outcome,
 tenant_id,correlation_id,source,severity,metadata
) VALUES (
 'audit-ci-tenant-a',1,'branch.updated','merchant','2026-11-07T00:00:00Z',
 'actor-a','merchant_user','branch.update','success','tenant-a','corr-a','api','info','{}'
);
INSERT INTO audit_events (
 id,schema_version,event_type,category,occurred_at,actor_id,actor_type,action,outcome,
 tenant_id,correlation_id,source,severity,metadata
) VALUES (
 'audit-ci-tenant-b',1,'branch.updated','merchant','2026-11-07T00:00:00Z',
 'actor-b','merchant_user','branch.update','success','tenant-b','corr-b','api','info','{}'
);
DO $$
BEGIN
 IF (SELECT count(*) FROM audit_events WHERE tenant_id='tenant-a') <> 1 THEN
   RAISE EXCEPTION 'tenant A audit event missing';
 END IF;
 IF (SELECT count(*) FROM audit_events WHERE tenant_id='tenant-a' AND id='audit-ci-tenant-b') <> 0 THEN
   RAISE EXCEPTION 'cross-tenant audit visibility detected';
 END IF;
 BEGIN
   UPDATE audit_events SET action='tampered' WHERE id='audit-ci-tenant-a';
   RAISE EXCEPTION 'audit update unexpectedly succeeded';
 EXCEPTION WHEN raise_exception THEN
   IF SQLERRM = 'audit update unexpectedly succeeded' THEN RAISE; END IF;
 END;
END $$;
ROLLBACK;
