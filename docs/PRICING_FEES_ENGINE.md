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
