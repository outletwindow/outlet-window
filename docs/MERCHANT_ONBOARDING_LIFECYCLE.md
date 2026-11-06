# Outlet Window — Merchant Onboarding & Lifecycle

Document ID: OW-MERCHANT-ONBOARDING-001
Version: 1.0
Status: Draft

## 1. Purpose
Define the complete merchant onboarding, verification, activation, operations, suspension and offboarding lifecycle.

## 2. Core Principles
- Only authorized and contracted merchants may operate.
- Every merchant must have a verified business identity.
- Each branch must be independently registered and verified.
- Merchant permissions must follow role-based access control.
- No merchant may access another merchant's private data.
- Activation requires commercial, legal, technical and operational readiness.

## 3. Merchant Types
Support:
- Retail store.
- Multi-branch retailer.
- Brand with direct fulfillment.
- Marketplace seller.
- Authorized distributor.
- Service provider, where supported.

Merchant type determines available integrations and services.

## 4. Application Submission
Collect only necessary information:
- Legal business name.
- Trading name.
- Registration and licensing information as required.
- Authorized representative.
- Business contact details.
- Country and operating locations.
- Business categories.
- Requested services.
- Proposed settlement details through secure approved workflows.

Never request passwords, OTPs or payment card credentials.

## 5. Verification
Verification may include:
- Business registration validation.
- Authorized representative verification.
- Required licenses and permits.
- Ownership or authorization evidence.
- Bank account ownership verification through approved providers.
- Address and branch verification.
- Restricted category screening.

Verification results must include status, evidence reference, reviewer and timestamp.

## 6. Merchant Lifecycle
States:
- Application Started.
- Submitted.
- Under Review.
- Additional Information Required.
- Verification Pending.
- Commercial Review.
- Contract Pending.
- Integration Pending.
- Testing.
- Approved.
- Active.
- Restricted.
- Suspended.
- Terminated.
- Archived.

Every transition must have a defined authorization and reason.

## 7. Contract Management
Store:
- Contract version.
- Parties.
- Effective date.
- Renewal date.
- Commercial terms.
- Commission and fees.
- Settlement schedule.
- Returns and refund responsibilities.
- Service-level agreements.
- Data processing terms.
- Termination conditions.

Contract changes require authorized approval and version history.

## 8. Branch Management
Each branch must include:
- Unique branch ID.
- Merchant ID.
- Verified address and coordinates.
- Operating hours.
- Service coverage.
- Supported categories.
- Fulfillment capabilities.
- Contact details.
- Inventory integration status.
- Pickup and handover settings.

Branch activation requires successful validation.

## 9. Product and Inventory Integration
Supported methods:
- Authorized API integration.
- POS integration.
- ERP integration.
- E-commerce platform integration.
- Approved CSV import.
- Authorized manual updates.

Record data source, last synchronization time and data confidence.

Do not claim real-time stock availability unless the integration supports it.

## 10. Merchant Services
Services may include:
- Product listing.
- Inventory synchronization.
- Order fulfillment.
- Store pickup.
- Courier pickup.
- Mall shopper fulfillment.
- Returns and exchanges.
- Analytics and reporting.

Each service requires separate eligibility and activation checks.

## 11. Merchant User Roles
Support:
- Merchant Owner.
- Merchant Administrator.
- Branch Manager.
- Order Receiver.
- Picker.
- Packer.
- Handover Officer.
- Finance Viewer.
- Auditor.

Permissions must be limited to the assigned merchant and branches.

## 12. Merchant Performance
Monitor:
- Order acceptance rate.
- Preparation time.
- Stock accuracy.
- Cancellation rate.
- Fulfillment accuracy.
- Handover compliance.
- Return rate.
- Customer complaints.
- Integration reliability.

Performance metrics must be based on traceable evidence.

## 13. Suspension and Restrictions
Possible actions:
- Restrict a branch.
- Pause a category.
- Disable a service.
- Pause new orders.
- Suspend merchant access.
- Terminate the commercial relationship.

Actions require authorization, documented reasons and appropriate notification.

Protect existing customer orders, refunds and legal obligations.

## 14. Offboarding
When a merchant exits:
- Stop accepting new orders as appropriate.
- Resolve existing orders.
- Complete outstanding settlements.
- Handle returns and disputes.
- Revoke integrations and access.
- Preserve legally required records.
- Apply the approved data retention policy.

## 15. AI Assistance
AI agents may:
- Review application completeness.
- Identify missing documents.
- Detect inconsistent information.
- Monitor integration health.
- Prepare performance reports.
- Recommend corrective actions.

AI must not independently approve legal identity, sign contracts, transfer funds or impose high-impact penalties.

## 16. Audit and Security
Record:
- Application and verification events.
- Contract changes.
- Branch changes.
- User access changes.
- Integration activity.
- Service activation and suspension.
- Settlement-related administrative actions.

Protect documents and sensitive merchant information using encryption and least-privilege access.

## 17. Acceptance Criteria
- Merchant application workflow exists.
- Verification workflow is auditable.
- Contract versions are controlled.
- Branches are independently managed.
- Integration health is monitored.
- Merchant roles are enforced.
- Activation gates are enforced.
- Suspension and offboarding are tested.
- Customer obligations are preserved.

## 18. Implementation Status
This document defines requirements and lifecycle controls. It does not indicate that merchant onboarding, verification or integrations are currently implemented or operational.
