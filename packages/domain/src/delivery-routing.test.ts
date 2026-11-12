import { describe, expect, it } from "vitest";
import { rankEligibleBranchesByRoadEta, type DeliveryRoutingProvider } from "./delivery-routing.js";

const nowUtc = "2026-11-08T12:00:00.000Z";
const candidates = [
  { merchantId: "m2", branchId: "b2", location: { latitude: 27.02, longitude: 49.65 } },
  { merchantId: "m1", branchId: "b1", location: { latitude: 27.01, longitude: 49.65 } },
  { merchantId: "m3", branchId: "b3", location: { latitude: 27.03, longitude: 49.65 } }
];
const provider: DeliveryRoutingProvider = {
  async estimateRoute({ origin }) {
    if (origin.latitude === 27.03) return null;
    return {
      distanceMeters: origin.latitude === 27.02 ? 1800 : 2400,
      durationSeconds: origin.latitude === 27.02 ? 420 : 420,
      providerReference: "route-ref",
      estimatedAtUtc: nowUtc
    };
  }
};

describe("road ETA branch ranking", () => {
  it("ranks eligible branches by ETA, then road distance, and ignores unavailable routes", async () => {
    const ranked = await rankEligibleBranchesByRoadEta({
      candidates, destination: { latitude: 27.0, longitude: 49.65 }, provider, nowUtc
    });
    expect(ranked.map(x => x.branchId)).toEqual(["b2", "b1"]);
  });

  it("rejects duplicate branches and invalid coordinates", async () => {
    await expect(rankEligibleBranchesByRoadEta({
      candidates: [candidates[0]!, candidates[0]!],
      destination: { latitude: 27, longitude: 49 }, provider, nowUtc
    })).rejects.toThrow("invalid_branch_candidate");
    await expect(rankEligibleBranchesByRoadEta({
      candidates, destination: { latitude: 91, longitude: 0 }, provider, nowUtc
    })).rejects.toThrow("invalid_routing_request");
  });

  it("discards stale and malformed provider estimates", async () => {
    const staleProvider: DeliveryRoutingProvider = {
      async estimateRoute() {
        return { distanceMeters: 100, durationSeconds: 20, providerReference: "old",
          estimatedAtUtc: "2026-11-08T11:54:59.000Z" };
      }
    };
    expect(await rankEligibleBranchesByRoadEta({
      candidates: [candidates[0]!], destination: { latitude: 27, longitude: 49 },
      provider: staleProvider, nowUtc
    })).toEqual([]);
  });
});
