\set ON_ERROR_STOP on
BEGIN;
INSERT INTO merchants(id,legal_name,display_name,country_code,status)
VALUES('dispatch-offer-ci-merchant','Dispatch Offer Test LLC','Dispatch Offer Test','SA','active');
INSERT INTO merchant_branches(id,merchant_id,display_name,city_code,status)
VALUES('dispatch-offer-ci-branch','dispatch-offer-ci-merchant','Dispatch Offer Branch','JUB','active');
INSERT INTO customer_orders(id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES('dispatch-offer-ci-order','platform','dispatch-offer-ci-customer','dispatch-offer-ci-order-key','confirmed','SAR',10000);
INSERT INTO merchant_suborders(id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES('dispatch-offer-ci-suborder','dispatch-offer-ci-merchant','dispatch-offer-ci-order','dispatch-offer-ci-merchant','dispatch-offer-ci-branch','ready_for_pickup',10000);
INSERT INTO courier_dispatch_offers(id,tenant_id,suborder_id,courier_id,expires_at) VALUES
('dispatch-offer-ci-a','dispatch-offer-ci-merchant','dispatch-offer-ci-suborder','courier-a',now()+interval '5 minutes'),
('dispatch-offer-ci-b','dispatch-offer-ci-merchant','dispatch-offer-ci-suborder','courier-b',now()+interval '5 minutes');
DO $$ BEGIN
 BEGIN
  INSERT INTO courier_dispatch_offers(id,tenant_id,suborder_id,courier_id,expires_at)
  VALUES('dispatch-offer-ci-duplicate','dispatch-offer-ci-merchant','dispatch-offer-ci-suborder','courier-a',now()+interval '5 minutes');
  RAISE EXCEPTION 'duplicate pending courier offer unexpectedly accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;
INSERT INTO courier_delivery_tasks(id,tenant_id,suborder_id,courier_id,status,idempotency_key)
VALUES('dispatch-offer-ci-task','dispatch-offer-ci-merchant','dispatch-offer-ci-suborder','courier-a','accepted','dispatch-offer-ci-task-key');
UPDATE courier_dispatch_offers SET status='accepted',responded_at=now(),accepted_task_id='dispatch-offer-ci-task',version=version+1,updated_at=now()
WHERE id='dispatch-offer-ci-a' AND tenant_id='dispatch-offer-ci-merchant';
INSERT INTO courier_dispatch_offer_events(id,tenant_id,offer_id,sequence,from_status,to_status,actor_id,actor_role,occurred_at)
VALUES('dispatch-offer-ci-event','dispatch-offer-ci-merchant','dispatch-offer-ci-a',2,'offered','accepted','courier-a','courier',now());
DO $$ BEGIN
 BEGIN
  UPDATE courier_dispatch_offers SET status='accepted',responded_at=now(),accepted_task_id='dispatch-offer-ci-task',version=version+1,updated_at=now()
  WHERE id='dispatch-offer-ci-b' AND tenant_id='dispatch-offer-ci-merchant';
  RAISE EXCEPTION 'second accepted offer unexpectedly accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  UPDATE courier_dispatch_offer_events SET reason='tampered' WHERE id='dispatch-offer-ci-event';
  RAISE EXCEPTION 'dispatch offer event unexpectedly mutable';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'courier_dispatch_offer_events are append-only' THEN RAISE; END IF;
 END;
 BEGIN
  INSERT INTO courier_dispatch_offers(id,tenant_id,suborder_id,courier_id,status,expires_at)
  VALUES('dispatch-offer-ci-invalid','dispatch-offer-ci-merchant','dispatch-offer-ci-suborder','courier-c','expired',now()+interval '5 minutes');
  RAISE EXCEPTION 'invalid expired offer unexpectedly accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;
