# Outlet Window — Pricing & Fees Engine

Version: 1.0
Status: Draft — Pending Commercial and Legal Review

## 1. Purpose
Define a configurable pricing engine for customers, merchants, couriers, shoppers and platform services across local, national and international markets.

## 2. Design Principles
- Transparent pricing before customer confirmation.
- No hidden fees.
- Configurable rules by country, city, service, merchant, distance and vehicle.
- Every quote has a version, currency, timestamp and expiry.
- Pricing changes never silently alter an already confirmed order.
- AI may recommend pricing changes but cannot publish them without authorization.

## 3. Customer Price Components
A quote may include:
- Product subtotal.
- Delivery fee.
- Shopper or collection service fee.
- Platform service fee.
- Packaging or special handling fee.
- Applicable taxes.
- Discounts and promotions.
- Optional membership benefits.

Only applicable components are shown and charged.

## 4. Merchant Financial Components
- Product proceeds.
- Merchant-funded discounts.
- Platform commission.
- Merchant service fees.
- Delivery responsibility.
- Refund adjustments.
- Applicable taxes.
- Net settlement amount.

All amounts follow the merchant contract and approved market rules.

## 5. Courier Compensation
Configurable inputs may include:
- Pickup and delivery distance.
- Number of pickup locations.
- Delivery distance and complexity.
- Waiting time under approved rules.
- Vehicle type and capacity.
- Special handling.
- Approved incentives and bonuses.

Compensation must be visible before task acceptance where applicable.

## 6. Shopper Compensation
Configurable inputs may include:
- Number of stores visited.
- Number of items collected.
- Task complexity.
- Expected task duration.
- Special handling requirements.
- Approved bonuses.

The shopper sees task scope and compensation before acceptance.

## 7. Distance and Geographic Pricing
- Use eligible road distance where routing data is available.
- Define service zones and maximum operating distances.
- Account for multi-store trips and grouped deliveries.
- Distinguish estimated distance from final verified distance.
- Avoid charging for unapproved route changes.

## 8. Multi-Store Orders
- Calculate each suborder's applicable costs.
- Identify shared delivery costs.
- Apply a documented allocation method.
- Prevent duplicate charges.
- Show the customer the total and relevant breakdown before payment.

## 9. Scheduled and International Orders
- Revalidate stock, pricing and serviceability before fulfillment.
- Show delivery estimates and applicable customs or import charges when known.
- Clearly identify estimates and charges collected by third parties.
- Do not promise a final customs amount when it cannot be reliably determined.

## 10. Discounts and Memberships
Support:
- Merchant-funded promotions.
- Platform-funded promotions.
- Shared-funded promotions.
- Coupons and loyalty benefits.
- Membership delivery benefits.

Record who funds each discount and its effect on settlement.

## 11. Pricing Governance
Every pricing rule must include:
- Rule ID and version.
- Market and currency.
- Effective date.
- Eligible services and users.
- Calculation method.
- Approval record.
- Expiry or review date.

High-impact changes require authorized approval and simulation before activation.

## 12. Simulation and Monitoring
The Business Simulation Engine evaluates:
- Revenue and contribution margin.
- Courier and shopper compensation.
- Merchant economics.
- Customer conversion.
- Promotion costs.
- Demand and capacity scenarios.

Simulations are advisory and never modify live pricing automatically.

## 13. Acceptance Criteria
- Quotes are reproducible and auditable.
- Customers see applicable fees before confirmation.
- Merchant and workforce amounts follow approved rules.
- Multi-store fees are allocated without duplication.
- Currency and taxes are explicit.
- Confirmed orders retain their agreed pricing rules.
- Unauthorized pricing changes are rejected.
- Automated tests cover edge cases and rounding.

## 14. Implementation Status
Specification only. No final prices, commercial rates, tax treatment or live pricing rules have been approved or deployed.

## 15. Implemented quote calculation foundation
- Deterministic pure quote calculator uses integer minor currency units and never invents tax, delivery or commission rates.
- Each quote carries a rule ID/version, currency, component breakdown, creation time and expiry.
- Rejects invalid currencies, fractional/negative component amounts, unsafe integer overflow, invalid quote windows and discounts exceeding the component sum.
- Quote usability is bounded by its original validity window; expiry cannot be extended by the client.
- Unit tests cover arithmetic, validation, overflow and expiry.
- Still not a live pricing service: market-specific rules, road-distance provider, tax configuration, merchant contracts, approval workflow, persistence and customer checkout integration remain to be implemented and reviewed.

## 16. Database-backed delivery quote resolver
- Resolves active service areas by tenant, country, city and effective window.
- Rejects coordinates outside every configured service area.
- Resolves only active, approved pricing rules matching service area, service code and currency.
- Confirms that at least one active merchant branch is assigned to the area and returns the eligible branch list.
- Calculates a versioned, expiring quote using the configured `fixed_plus_distance` rule and integer minor units.
- Fails closed for missing rules, malformed configuration, invalid coordinates and missing eligible branches.
- PostgreSQL migration 0011 adds service areas, branch assignments, versioned pricing rules, approval fields and append-only rule events. CI acceptance tests verify approval gates, immutable approved snapshots and audit immutability.
- Important limitation: the current distance basis is straight-line distance from the service-area center, not road distance. The resolver returns eligible branches but does not yet rank them by branch-to-customer road ETA. It is a backend foundation, not yet wired into the production checkout or delivery-destination API. Production use requires a trusted routing provider, branch geocoordinates, tenant/merchant ownership enforcement, authorized admin approval workflows and payment-provider integration.

## 17. Road ETA branch ranking contract
- Added a provider-neutral routing contract for obtaining road distance and travel duration from each eligible branch to the customer destination.
- Branches are ranked by ETA, then road distance, then stable merchant/branch identifiers.
- Unavailable routes are excluded; stale estimates older than five minutes and malformed provider responses are discarded.
- Duplicate branch candidates and invalid coordinates are rejected.
- Unit tests cover ranking, unavailable routes, stale estimates and invalid inputs.
- No routing vendor credentials or endpoint are configured. This contract is not a live maps integration and must be connected to an approved routing provider before using ETA for customer promises or dispatch decisions.

## 18. Branch geolocation and quote-to-routing composition
- Migration 0012 adds optional latitude/longitude columns to merchant branches, with paired-coordinate and geographic-range constraints.
- Merchant branch create/update writes accept optional coordinates and validate the pair and ranges before SQL.
- `PostgresDeliveryQuoteService.quoteWithRoadEta` resolves the quote, loads only geocoded active branches assigned to the selected service area, and ranks them through the injected routing provider.
- API readiness now requires migrations 0011 and 0012.
- Historical note superseded by section 19: the road-ETA quote path now fails closed unless at least one branch has a fresh valid route. Branches without coordinates are excluded from ETA ranking. A production routing provider is still not configured.

## 19. Road-distance-based branch selection and delivery pricing
- `quoteWithRoadEta` now requires a fresh road route for at least one geocoded eligible branch.
- Selects the lowest-ETA branch (road distance and stable IDs break ties) and returns the selected merchant/branch identifiers.
- Recalculates the delivery fee from the selected branch's provider-reported road distance using the approved versioned fixed-plus-distance rule, rather than using the service-area center estimate.
- The final quote retains the original quote expiry and rule version; if no valid route or valid pricing rule exists, the operation fails closed.
- Unit tests assert the selected branch, road distance and recalculated integer fee.
- A production routing provider is still not configured. Do not expose this as a customer quote until a trusted provider is wired and its route freshness, coverage, rate limits and service terms are verified.

## 20. Secure HTTP routing gateway adapter
- Added a provider-neutral HTTP adapter for a deployment-controlled routing gateway.
- Requires HTTPS, bearer credentials, redirect rejection and bounded request timeout (250–15,000 ms).
- Sends origin/destination coordinates in metric units; normalizes valid distance, duration and provider reference into a fresh estimate.
- Treats no-route responses as unavailable, classifies transient HTTP failures without logging or exposing provider response bodies, and rejects malformed payloads.
- Unit tests cover request shape, HTTPS/credential enforcement, timeout validation, no-route behavior, malformed data and transient errors.
- This is an adapter contract only. No external map vendor is selected or configured, no production credentials exist in the repository, and live road ETA remains unavailable until deployment supplies an approved gateway and secrets.
