export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface RouteEstimate {
  distanceMeters: number;
  durationSeconds: number;
  providerReference: string;
  estimatedAtUtc: string;
}

export interface DeliveryRoutingProvider {
  estimateRoute(input: { origin: GeoPoint; destination: GeoPoint }): Promise<RouteEstimate | null>;
}

export interface BranchRouteCandidate {
  merchantId: string;
  branchId: string;
  location: GeoPoint;
}

export interface RankedBranchRoute extends BranchRouteCandidate {
  route: RouteEstimate;
}

/** Validates untrusted routing-provider output before it influences branch selection. */
export function isValidRouteEstimate(value: unknown, nowUtc: string): value is RouteEstimate {
  if (value === null || typeof value !== "object") return false;
  const route = value as Partial<RouteEstimate>;
  if (!Number.isSafeInteger(route.distanceMeters) || (route.distanceMeters as number) < 0 ||
      !Number.isSafeInteger(route.durationSeconds) || (route.durationSeconds as number) < 0 ||
      typeof route.providerReference !== "string" || route.providerReference.trim().length === 0 ||
      route.providerReference.length > 240 || typeof route.estimatedAtUtc !== "string") return false;
  const now = Date.parse(nowUtc);
  const estimated = Date.parse(route.estimatedAtUtc);
  return Number.isFinite(now) && Number.isFinite(estimated) &&
    estimated <= now && now - estimated <= 5 * 60_000;
}

/** Queries all eligible branches and ranks by provider-reported road ETA, then distance, then stable IDs. */
export async function rankEligibleBranchesByRoadEta(input: {
  candidates: readonly BranchRouteCandidate[];
  destination: GeoPoint;
  provider: DeliveryRoutingProvider;
  nowUtc: string;
}): Promise<readonly RankedBranchRoute[]> {
  if (!Number.isFinite(input.destination.latitude) || input.destination.latitude < -90 ||
      input.destination.latitude > 90 || !Number.isFinite(input.destination.longitude) ||
      input.destination.longitude < -180 || input.destination.longitude > 180 ||
      !Number.isFinite(Date.parse(input.nowUtc))) {
    throw new Error("invalid_routing_request");
  }
  const unique = new Set<string>();
  for (const candidate of input.candidates) {
    const key = candidate.merchantId + "\u0000" + candidate.branchId;
    if (!candidate.merchantId.trim() || !candidate.branchId.trim() || unique.has(key) ||
        !Number.isFinite(candidate.location.latitude) || candidate.location.latitude < -90 ||
        candidate.location.latitude > 90 || !Number.isFinite(candidate.location.longitude) ||
        candidate.location.longitude < -180 || candidate.location.longitude > 180) {
      throw new Error("invalid_branch_candidate");
    }
    unique.add(key);
  }
  const estimates = await Promise.all(input.candidates.map(async candidate => ({
    candidate,
    route: await input.provider.estimateRoute({
      origin: candidate.location, destination: input.destination
    })
  })));
  const ranked: RankedBranchRoute[] = [];
  for (const item of estimates) {
    if (item.route === null) continue;
    if (!isValidRouteEstimate(item.route, input.nowUtc)) continue;
    ranked.push({ ...item.candidate, route: item.route });
  }
  return ranked.sort((a, b) =>
    a.route.durationSeconds - b.route.durationSeconds ||
    a.route.distanceMeters - b.route.distanceMeters ||
    a.merchantId.localeCompare(b.merchantId) ||
    a.branchId.localeCompare(b.branchId)
  );
}
