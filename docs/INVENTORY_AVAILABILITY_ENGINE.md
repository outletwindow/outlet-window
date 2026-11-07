# Outlet Window — Inventory & Availability Engine

Version: 1.0
Status: Draft — Pending Technical Review

## 1. Purpose
Provide accurate, branch-level product availability for Outlet Window across supported merchants, cities and markets.

## 2. System Ownership
- Inventory Engine owns stock availability, stock reservations and inventory synchronization status.
- Merchant Portal owns merchant-facing inventory management interfaces.
- Order Management owns customer orders.
- Product Catalog owns product descriptions and variant identities.
- Dispatch Engine owns delivery assignment.
- Audit System owns inventory change records.

## 3. Merchant Integrations
Supported integration methods:
- Authorized POS integrations.
- ERP APIs.
- E-commerce platform APIs.
- Merchant-provided CSV files.
- Merchant Portal manual updates.
- Approved scheduled synchronization.

Only authorized merchant data may be accessed.

## 4. Product Identification
Each product variant must support:
- Merchant ID.
- Branch ID.
- Product ID.
- SKU or barcode.
- Size.
- Color.
- Price reference.
- Available quantity.
- Reserved quantity.
- Last synchronization timestamp.
- Data source.
- Availability confidence.

## 5. Branch Availability
- Track inventory separately for each branch.
- Display only eligible branches for the delivery address.
- Support nearby branches when market rules allow.
- Clearly identify outdated inventory data.
- Do not claim real-time availability without a supporting integration.

## 6. Stock Reservations
- Validate stock before checkout confirmation.
- Reserve stock atomically when supported.
- Prevent concurrent overselling within the platform.
- Apply reservation expiration policies.
- Release reservations after eligible cancellation or expiration.
- Reconcile reservations with merchant inventory.
- Treat external merchant stock changes as possible conflicts.

## 6A. Scheduled Order Reservation

For scheduled orders, the order and payment confirmation happen at checkout; the inventory reservation request is sent to the selected branch immediately, not at the later preparation time. Where the merchant integration supports hard reservations, reserve the exact variant and quantity atomically and record reservation expiry. The merchant may receive an early reservation notification while the picking/preparation task remains queued until the calculated release time.

If a hard reservation is not supported, mark availability as unguaranteed and revalidate before preparation. A reservation failure must trigger an exception and customer alternatives, not a false confirmation. Suggested alternatives may include another authorized branch, another variant or a similar product, with price and time differences shown for customer approval.

## 7. Inventory Synchronization
- Support webhooks where available.
- Support scheduled polling.
- Detect missing or delayed updates.
- Apply source priority rules.
- Record synchronization failures.
- Retry safely with backoff.
- Never silently overwrite unresolved stock conflicts.

## 8. Multi-Branch Fulfillment
- Find eligible branches with required variants.
- Consider distance, availability, preparation time and delivery capacity.
- Support splitting orders across branches with customer approval where required.
- Recalculate costs and delivery estimates before confirmation.
- Do not substitute products without consent.

## 9. Low Stock and Out-of-Stock
- Alert merchants when supported.
- Hide or mark unavailable variants according to freshness rules.
- Suggest eligible alternatives.
- Notify customers of changes before payment confirmation.
- Support restock alerts with customer consent.

## 10. Inventory Adjustments
- Require authorized roles.
- Record previous and new quantities.
- Capture adjustment reason and source.
- Maintain audit history.
- Detect unusual changes.
- Require additional approval for high-risk adjustments.

## 11. AI Assistance
- Forecast demand.
- Detect inventory anomalies.
- Recommend replenishment.
- Identify synchronization issues.
- Suggest stock distribution improvements.
- Never invent stock quantities.
- Never change merchant inventory without authorization.

## 12. Security and Data Governance
- Enforce merchant and branch data isolation.
- Use least-privilege integration credentials.
- Encrypt sensitive integration data.
- Respect merchant data agreements.
- Log access and modifications.
- Prevent cross-merchant inventory leakage.

## 13. Monitoring
- Inventory synchronization success rate.
- Inventory data freshness.
- Stock mismatch rate.
- Reservation conflicts.
- Out-of-stock cancellation rate.
- API integration failures.
- Inventory accuracy by merchant and branch.

## 14. Acceptance Criteria
- Inventory is correctly isolated by merchant and branch.
- Product variants are uniquely identifiable.
- Reservations prevent platform-side double allocation.
- Stale inventory is clearly identified.
- External stock conflicts are handled safely.
- All adjustments are auditable.
- Merchant authorization is enforced.
- Inventory availability is not falsely represented as guaranteed.

## 15. Implementation Status
Specification only. No merchant POS, ERP, inventory API or live stock integration is claimed to be operational.
\n\n## 15. Implementation note (development branch)\nA PostgreSQL branch inventory ledger and atomic platform-side reservation adapter have been added, together with order item lines and reservation records. The adapter locks all requested variant rows and reserves all requested lines in one transaction, or none. This prevents two Outlet Window transactions from allocating the same final unit. It does not by itself prove that an external POS/ERP has accepted a hard reservation; external merchant acknowledgement, stock synchronization, expiry/release, reconciliation, and checkout wiring remain pending.\n

Reservation lifecycle support now includes idempotent release, expiry and consumption persistence. These transitions update the platform stock allocation ledger atomically. A background expiry scheduler, stock synchronization adapters, external merchant hard-reservation acknowledgement and full reconciliation remain pending.
