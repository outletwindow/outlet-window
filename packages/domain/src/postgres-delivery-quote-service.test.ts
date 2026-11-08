import { describe, expect, it } from "vitest";
import { PostgresDeliveryQuoteService } from "./postgres-delivery-quote-service.js";
import type { PostgresQueryable, PostgresQueryResult } from "./postgres-iam-store.js";

class FakeDatabase implements PostgresQueryable {
  constructor(private readonly mode: "valid" | "no_rule" | "no_branch" = "valid") {}
  async query<Row = Record<string, unknown>>(sql: string): Promise<PostgresQueryResult<Row>> {
    if (sql.includes("FROM delivery_service_areas")) return { rows: [{
      id: "area-1", center_latitude: 27.0046, center_longitude: 49.646,
      radius_meters: 10_000, currency: "SAR"
    } as Row], rowCount: 1 };
    if (sql.includes("FROM delivery_pricing_rules")) return this.mode === "no_rule"
      ? { rows: [], rowCount: 0 }
      : { rows: [{
          id: "rule-1", version: 2, currency: "SAR",
          calculation_config: { method: "fixed_plus_distance", base_fee_minor: 1000, per_km_minor: 200 }
        } as Row], rowCount: 1 };
    if (sql.includes("FROM delivery_service_area_branches")) return this.mode === "no_branch"
      ? { rows: [], rowCount: 0 }
      : { rows: [{ merchant_id: "merchant-1", branch_id: "branch-1" } as Row], rowCount: 1 };
    throw new Error("unexpected query");
  }
}

const request = {
  tenantId: "tenant-1", countryCode: "SA", cityCode: "JUBAIL",
  serviceCode: "standard_delivery",
  destination: { latitude: 27.01, longitude: 49.65 },
  quoteId: "quote-1", nowUtc: "2026-11-08T12:00:00.000Z"
};

describe("PostgresDeliveryQuoteService", () => {
  it("resolves a service area, approved rule and eligible branches into an expiring quote", async () => {
    const result = await new PostgresDeliveryQuoteService(new FakeDatabase()).quote(request);
    expect(result.status).toBe("quoted");
    if (result.status !== "quoted") return;
    expect(result.eligibleBranches).toEqual([{ merchantId: "merchant-1", branchId: "branch-1" }]);
    expect(result.quote.ruleVersion).toBe(2);
    expect(result.quote.currency).toBe("SAR");
    expect(result.quote.totalMinor).toBeGreaterThanOrEqual(1000);
    expect(result.quote.expiresAtUtc).toBe("2026-11-08T12:05:00.000Z");
  });

  it("rejects destinations outside configured service areas", async () => {
    const result = await new PostgresDeliveryQuoteService(new FakeDatabase()).quote({
      ...request, destination: { latitude: 27.5, longitude: 49.65 }
    });
    expect(result).toEqual({ status: "outside_service_area" });
  });

  it("fails closed when no approved active pricing rule exists", async () => {
    const result = await new PostgresDeliveryQuoteService(new FakeDatabase("no_rule")).quote(request);
    expect(result).toEqual({ status: "no_active_pricing_rule" });
  });

  it("fails closed when no active merchant branch is assigned to the area", async () => {
    const result = await new PostgresDeliveryQuoteService(new FakeDatabase("no_branch")).quote(request);
    expect(result).toEqual({ status: "no_eligible_branch" });
  });

  it("rejects malformed coordinates and quote expiry settings", async () => {
    const service = new PostgresDeliveryQuoteService(new FakeDatabase());
    expect(await service.quote({ ...request, destination: { latitude: 91, longitude: 0 } }))
      .toEqual({ status: "invalid_request" });
    expect(await service.quote({ ...request, validitySeconds: 901 }))
      .toEqual({ status: "invalid_request" });
  });
});
