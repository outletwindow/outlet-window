\set ON_ERROR_STOP on
BEGIN;
INSERT INTO tenants (id,tenant_type,display_name,status)
VALUES ('cap-inbox-tenant','platform','Capture Inbox Test Tenant','active');
INSERT INTO customer_orders (id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('cap-inbox-order','cap-inbox-tenant','cap-customer','cap-order-idem','awaiting_payment','SAR',12500);
INSERT INTO provider_payment_intents
(id,tenant_id,order_id,provider_key,provider_payment_reference,amount_minor,currency,idempotency_key,expires_at)
VALUES ('cap-inbox-intent','cap-inbox-tenant','cap-inbox-order','psp-a','cap-ref-1',12500,'SAR','cap-intent-idem',now()+interval '15 minutes');
INSERT INTO initial_payment_capture_webhook_events
(id,provider_key,provider_event_id,payment_intent_id,payload_sha256,event_type,provider_payment_reference,amount_minor,currency,captured_at)
VALUES ('cap-event-1','psp-a','evt-1','cap-inbox-intent',repeat('a',64),'payment.captured','cap-ref-1',12500,'SAR',now());
DO $$ BEGIN
  BEGIN
    INSERT INTO initial_payment_capture_webhook_events
    (id,provider_key,provider_event_id,payment_intent_id,payload_sha256,event_type,provider_payment_reference,amount_minor,currency,captured_at)
    VALUES ('cap-event-duplicate','psp-a','evt-1','cap-inbox-intent',repeat('a',64),'payment.captured','cap-ref-1',12500,'SAR',now());
    RAISE EXCEPTION 'expected duplicate provider event rejection';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    UPDATE initial_payment_capture_webhook_events SET amount_minor=1 WHERE id='cap-event-1';
    RAISE EXCEPTION 'expected immutable capture event identity rejection';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
  BEGIN
    UPDATE initial_payment_capture_webhook_events SET status='processing',lease_owner='worker-a' WHERE id='cap-event-1';
    RAISE EXCEPTION 'expected lease pair constraint rejection';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
UPDATE initial_payment_capture_webhook_events
SET status='processing',lease_owner='worker-a',lease_expires_at=now()+interval '30 seconds',attempt_count=1
WHERE id='cap-event-1';
UPDATE initial_payment_capture_webhook_events
SET status='applied',processed_at=now(),lease_owner=NULL,lease_expires_at=NULL
WHERE id='cap-event-1';
DO $$ BEGIN
  BEGIN
    TRUNCATE initial_payment_capture_webhook_events;
    RAISE EXCEPTION 'expected truncate rejection';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
END $$;
ROLLBACK;
