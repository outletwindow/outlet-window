\set ON_ERROR_STOP on
BEGIN;
INSERT INTO identities(id,principal_type,status,display_name,primary_email,created_at,updated_at)
VALUES ('courier-profile-ci-user','human','active','Courier Profile Test','courier-profile-ci@example.test',now(),now());
INSERT INTO courier_profiles(courier_id,account_status,verification_status,max_concurrent_tasks,approved_by,approved_at)
VALUES ('courier-profile-ci-user','active','verified',2,'ci-reviewer',now());
INSERT INTO courier_availability(courier_id,available) VALUES ('courier-profile-ci-user',true);
INSERT INTO courier_vehicles(id,courier_id,vehicle_type,verification_status,capacity_weight_grams,capacity_volume_liters,active,verified_by,verified_at)
VALUES ('courier-profile-ci-bike','courier-profile-ci-user','motorcycle','verified',15000,80,true,'ci-reviewer',now());
INSERT INTO merchants(id,legal_name,display_name,country_code,status)
VALUES ('courier-profile-ci-merchant','Courier Profile LLC','Courier Profile','SA','active');
INSERT INTO merchant_branches(id,merchant_id,display_name,city_code,status)
VALUES ('courier-profile-ci-branch','courier-profile-ci-merchant','Courier Profile Branch','DMM','active');
INSERT INTO delivery_service_areas(id,tenant_id,country_code,city_code,display_name,center_latitude,center_longitude,radius_meters,currency,status,effective_from,created_by)
VALUES ('courier-profile-ci-zone','courier-profile-ci-merchant','SA','DMM','Dammam Test Zone',26.42,50.10,20000,'SAR','active',now(),'ci');
INSERT INTO courier_service_area_memberships(courier_id,tenant_id,service_area_id,approved_by,approved_at)
VALUES ('courier-profile-ci-user','courier-profile-ci-merchant','courier-profile-ci-zone','ci-reviewer',now());
INSERT INTO customer_orders(id,tenant_id,customer_id,idempotency_key,status,currency,total_minor)
VALUES ('courier-profile-ci-order','platform','courier-profile-ci-customer','courier-profile-ci-order-key','confirmed','SAR',10000);
INSERT INTO merchant_suborders(id,tenant_id,order_id,merchant_id,branch_id,status,subtotal_minor)
VALUES ('courier-profile-ci-suborder','courier-profile-ci-merchant','courier-profile-ci-order','courier-profile-ci-merchant','courier-profile-ci-branch','ready_for_pickup',10000);
INSERT INTO courier_dispatch_requirements(tenant_id,suborder_id,service_area_id,accepted_vehicle_types,package_weight_grams,package_volume_liters,created_by)
VALUES ('courier-profile-ci-merchant','courier-profile-ci-suborder','courier-profile-ci-zone','["motorcycle","car"]',5000,30,'dispatch-service');
DO $$
BEGIN
  BEGIN
    UPDATE courier_dispatch_requirements SET package_weight_grams=100 WHERE suborder_id='courier-profile-ci-suborder';
    RAISE EXCEPTION 'dispatch requirements unexpectedly mutable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'courier_dispatch_requirements_are_immutable' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO courier_profiles(courier_id,account_status,verification_status,approved_by,approved_at)
    VALUES ('missing-identity-courier','active','verified','ci',now());
    RAISE EXCEPTION 'courier profile without identity unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
ROLLBACK;
