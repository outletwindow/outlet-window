import type { PostgresClient } from "./postgres-iam-store.js";
import type { CourierDispatchOfferEligibility } from "./postgres-courier-dispatch-offer-command-store.js";

/**
 * Rechecks persisted courier identity, approval, heartbeat, zone membership,
 * verified vehicle capacity and concurrent workload inside the assignment
 * transaction. Locking the profile serializes simultaneous accepts by one courier.
 */
export class PostgresCourierDispatchOfferEligibility implements CourierDispatchOfferEligibility {
  async isEligible(input: {
    client: PostgresClient;
    tenantId: string;
    courierId: string;
    suborderId: string;
  }): Promise<boolean> {
    const eligible = await input.client.query<{ max_concurrent_tasks: number }>(
      `SELECT p.max_concurrent_tasks
       FROM courier_profiles p
       JOIN identities i ON i.id = p.courier_id AND i.status = 'active'
       JOIN courier_availability a ON a.courier_id = p.courier_id
       JOIN courier_dispatch_requirements r
         ON r.tenant_id = $1 AND r.suborder_id = $3
       JOIN courier_service_area_memberships m
         ON m.courier_id = p.courier_id
        AND m.tenant_id = r.tenant_id
        AND m.service_area_id = r.service_area_id
        AND m.active = true
       WHERE p.courier_id = $2
         AND p.account_status = 'active'
         AND p.verification_status = 'verified'
         AND a.available = true
         AND a.updated_at >= now() - interval '2 minutes'
         AND EXISTS (
           SELECT 1 FROM courier_vehicles v
           WHERE v.courier_id = p.courier_id
             AND v.active = true
             AND v.verification_status = 'verified'
             AND r.accepted_vehicle_types ? v.vehicle_type
             AND v.capacity_weight_grams >= r.package_weight_grams
             AND v.capacity_volume_liters >= r.package_volume_liters
         )
       FOR UPDATE OF p, a`,
      [input.tenantId, input.courierId, input.suborderId]
    );
    const profile = eligible.rows[0];
    if (!profile) return false;

    const workload = await input.client.query<{ active_count: number }>(
      `SELECT COUNT(*)::integer AS active_count
       FROM courier_delivery_tasks
       WHERE courier_id = $1
         AND status NOT IN ('declined','cancelled','failed')`,
      [input.courierId]
    );
    return (workload.rows[0]?.active_count ?? Number.MAX_SAFE_INTEGER) < profile.max_concurrent_tasks;
  }
}
