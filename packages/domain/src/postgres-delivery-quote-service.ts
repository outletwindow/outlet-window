import type { PostgresQueryable } from "./postgres-iam-store.js";
import { calculatePricingQuote, type PricingQuote } from "./order-pricing.js";
import { distanceBetweenCoordinatesMeters } from "./order-editing.js";

export interface DeliveryQuoteRequest {
  tenantId: string;
  countryCode: string;
  cityCode: string;
  serviceCode: string;
  destination: { latitude: number; longitude: number };
  quoteId: string;
  nowUtc: string;
  validitySeconds?: number;
}

export type DeliveryQuoteResult =
  | { status: "quoted"; serviceAreaId: string; currency: string; distanceFromZoneCenterMeters: number; eligibleBranches: readonly { merchantId: string; branchId: string }[]; quote: PricingQuote }
  | { status: "outside_service_area" | "no_active_pricing_rule" | "no_eligible_branch" | "invalid_request" };

type AreaRow = {
  id: string; center_latitude: string | number; center_longitude: string | number;
  radius_meters: number; currency: string;
};
type RuleRow = { id: string; version: number; currency: string; calculation_config: Record<string, unknown> };
type BranchRow = { merchant_id: string; branch_id: string };

/**
 * Resolves a tenant-scoped, currently active service area and approved pricing rule.
 * Distance is explicitly straight-line from the configured zone center; road routing
 * must replace it before this quote can be treated as a final dispatch ETA or route price.
 */
export class PostgresDeliveryQuoteService {
  constructor(private readonly database: PostgresQueryable) {}

  async quote(request: DeliveryQuoteRequest): Promise<DeliveryQuoteResult> {
    const { latitude, longitude } = request.destination;
    const now = Date.parse(request.nowUtc);
    const validity = request.validitySeconds ?? 300;
    if (!request.tenantId.trim() || !/^[A-Z]{2}$/.test(request.countryCode) ||
        !request.cityCode.trim() || !request.serviceCode.trim() ||
        !request.quoteId.trim() || !Number.isFinite(now) ||
        !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
        !Number.isSafeInteger(validity) || validity < 1 || validity > 900) {
      return { status: "invalid_request" };
    }

    const areas = await this.database.query<AreaRow>(
      `SELECT id, center_latitude, center_longitude, radius_meters, currency
       FROM delivery_service_areas
       WHERE tenant_id = $1 AND country_code = $2 AND city_code = $3
         AND status = 'active' AND effective_from <= $4
         AND (effective_until IS NULL OR effective_until > $4)
       ORDER BY id`,
      [request.tenantId, request.countryCode, request.cityCode, request.nowUtc]
    );
    const area = areas.rows.find(row => distanceBetweenCoordinatesMeters(
      { latitude: Number(row.center_latitude), longitude: Number(row.center_longitude) },
      request.destination
    ) <= row.radius_meters);
    if (!area) return { status: "outside_service_area" };

    const rules = await this.database.query<RuleRow>(
      `SELECT id, version, currency, calculation_config
       FROM delivery_pricing_rules
       WHERE tenant_id = $1 AND service_area_id = $2 AND service_code = $3
         AND currency = $4 AND status = 'active'
         AND approved_by IS NOT NULL AND approved_at IS NOT NULL
         AND effective_from <= $5 AND (effective_until IS NULL OR effective_until > $5)
       ORDER BY version DESC LIMIT 1`,
      [request.tenantId, area.id, request.serviceCode, area.currency, request.nowUtc]
    );
    const rule = rules.rows[0];
    if (!rule) return { status: "no_active_pricing_rule" };

    const branchResult = await this.database.query<BranchRow>(
      `SELECT link.merchant_id, link.branch_id
       FROM delivery_service_area_branches link
       JOIN merchant_branches branch
         ON branch.merchant_id = link.merchant_id AND branch.id = link.branch_id
       JOIN merchants merchant ON merchant.id = link.merchant_id
       WHERE link.tenant_id = $1 AND link.service_area_id = $2
         AND branch.status = 'active' AND merchant.status = 'active'
       ORDER BY link.merchant_id, link.branch_id`,
      [request.tenantId, area.id]
    );
    if (branchResult.rows.length === 0) return { status: "no_eligible_branch" };

    const config = rule.calculation_config;
    const method = config.method;
    const baseFee = config.base_fee_minor;
    const perKm = config.per_km_minor;
    const distanceMeters = distanceBetweenCoordinatesMeters(
      { latitude: Number(area.center_latitude), longitude: Number(area.center_longitude) },
      request.destination
    );
    if (method !== "fixed_plus_distance" ||
        !Number.isSafeInteger(baseFee) || (baseFee as number) < 0 ||
        !Number.isSafeInteger(perKm) || (perKm as number) < 0) {
      return { status: "no_active_pricing_rule" };
    }
    const distanceKmCeiling = Math.ceil(distanceMeters / 1000);
    const deliveryFee = (baseFee as number) + distanceKmCeiling * (perKm as number);
    if (!Number.isSafeInteger(deliveryFee)) return { status: "no_active_pricing_rule" };

    const quote = calculatePricingQuote({
      quoteId: request.quoteId, ruleId: rule.id, ruleVersion: rule.version,
      currency: rule.currency,
      components: [{ kind: "delivery", amountMinor: deliveryFee, label: "Delivery fee (zone-center distance estimate)" }],
      createdAtUtc: new Date(now).toISOString(),
      expiresAtUtc: new Date(now + validity * 1000).toISOString()
    });
    return {
      status: "quoted", serviceAreaId: area.id, currency: area.currency,
      distanceFromZoneCenterMeters: Math.round(distanceMeters),
      eligibleBranches: branchResult.rows.map(row => ({ merchantId: row.merchant_id, branchId: row.branch_id })),
      quote
    };
  }
}
