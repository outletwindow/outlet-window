# Outlet Window - Database Architecture

## 1. Purpose
Define the logical database architecture for a global, multi-merchant commerce and logistics platform. The initial implementation is planned for Jubail, Saudi Arabia, with a design that supports future countries and cities.

## 2. Database Technology — Proposal, Not Yet Approved
- Proposed primary relational database: PostgreSQL.
- Proposed ORM candidate: Prisma.
- Redis is an optional candidate for caching, queues, and short-lived operational data.
- Object storage is required for product images, invoices, and delivery evidence; provider selection is pending.
- These are architecture proposals only. Final database, ORM, cache, and cloud-provider choices remain pending an explicit owner decision.
- Database migrations must be version-controlled and reviewed.

## 3. Core Design Principles
- Use stable unique identifiers for all records.
- Separate business entities and their ownership boundaries.
- Enforce foreign keys and database constraints.
- Store timestamps in UTC and retain the applicable local timezone for display and scheduling.
- Store monetary amounts as integer minor units with an explicit currency code; never use floating-point values for money.
- Preserve historical order, payment, and handover records.
- Use soft deletion only where appropriate; financial and audit records must not be silently deleted.
- Apply data retention and privacy rules per market.

## 4. Identity and Access Domain
Core entities:
- User
- UserProfile
- AuthenticationIdentity
- Role
- Permission
- UserRole
- Session
- Device
- ConsentRecord

A person may have more than one authorized platform role, such as customer, shopper, or courier. Role permissions must remain explicit and context-specific.

## 5. Merchant and Store Domain
Core entities:
- Merchant
- MerchantUser
- MerchantRole
- Store
- StoreBranch
- StoreOperatingHours
- StoreServiceArea
- MerchantIntegration
- MerchantSettlementProfile

A merchant may own multiple branches. Branch access must be limited to authorized merchant users.

## 6. Product and Inventory Domain
Core entities:
- Product
- ProductVariant
- SKU
- Barcode
- ProductImage
- Category
- Brand
- BranchInventory
- InventoryMovement
- InventoryReservation
- InventorySyncLog

Inventory records must identify the branch, variant, quantity, source, last update time, and data confidence where applicable. Inventory availability must be revalidated before order confirmation.

## 7. Customer and Address Domain
Core entities:
- CustomerProfile
- CustomerAddress
- AddressLabel
- Favorite
- ShoppingCart
- CartItem

A customer may save multiple addresses. An order must preserve a snapshot of its confirmed delivery address so later address edits do not change historical orders.

## 8. Order Management Domain
Core entities:
- Order
- OrderItem
- SubOrder
- SubOrderItem
- OrderStatusHistory
- OrderAdjustment
- CancellationRequest
- ReturnRequest
- ReplacementRequest

A multi-merchant cart may produce one parent order and multiple suborders. Each suborder must identify its merchant and fulfillment branch where applicable.

## 9. Shopper Domain
Core entities:
- ShopperProfile
- ShopperEligibility
- ShopperType
- ShopperAvailability
- ShopperServiceArea
- ShopperTask
- ShopperTaskItem
- ShopperTaskEvidence
- ShopperEarning

Shopper types include Mall Personal Shopper, Store Employee Shopper, Independent Shopper, and Mall Collector. Store employees must only access tasks authorized for their store unless explicitly delegated.

## 10. Courier Domain
Core entities:
- CourierProfile
- CourierEligibility
- CourierVehicle
- CourierAvailability
- CourierServiceArea
- DeliveryTask
- DeliveryAssignment
- DeliveryRoute
- DeliveryLocationEvent
- DeliveryProof
- CourierEarning

Location tracking must be limited to authorized active delivery workflows and applicable privacy rules.

## 11. Unified Workforce and Task Domain
Core entities:
- WorkforceTask
- TaskAssignment
- TaskDependency
- TaskOffer
- TaskAcceptance
- TaskStatusHistory
- TaskRewardRule
- TaskRewardRecord

Shopper and courier workflows remain separate, while shared task coordination uses a central workforce task service. Every assignment must record its responsible role and actor.

## 12. Handover and Invoice Domain
Core entities:
- HandoverRecord
- HandoverParticipant
- HandoverVerification
- QRToken
- InvoiceRecord
- InvoiceLineItem
- InvoiceExtraction
- InvoiceDiscrepancy
- EvidenceFile

Maintain four separate sources of truth:
- Payments records what was paid.
- Invoice Intelligence records what the invoice shows.
- Order Management records what the customer ordered.
- Unified Handover records what was physically transferred and who was responsible.

Discrepancies must be sent for review. OCR results must never silently modify payments or confirm receipt.

## 13. Payments and Finance Domain
Core entities:
- Payment
- PaymentAttempt
- Refund
- RefundLine
- FinancialLedgerAccount
- LedgerEntry
- MerchantSettlement
- CourierPayout
- ShopperPayout
- FeeRecord
- TaxRecord
- ReconciliationRecord

Financial entries must be auditable and consistent. Payment processing must use approved providers. Sensitive card details must not be stored by the platform unless explicitly permitted and securely designed under applicable standards.

## 14. Logistics and Fulfillment Domain
Core entities:
- FulfillmentRequest
- PickupLocation
- DeliveryLocation
- Shipment
- Carrier
- TrackingEvent
- DeliveryZone
- ServiceAvailability
- FulfillmentException

Support local delivery, scheduled fulfillment, store pickup, multi-store fulfillment, national shipping, and international shipping as separately enabled capabilities.

## 15. Owner Control and AI Domain
Core entities:
- AIAgent
- AITask
- AITaskExecution
- AIAgentPermission
- AIRecommendation
- ApprovalRequest
- ApprovalDecision
- MonitoringEvent
- Incident
- AutomationPolicy
- AIUsageCost

AI agents must operate through controlled services and least-privilege permissions. Sensitive actions require explicit approval. Agent activity and automated actions must be auditable.

## 16. Support, Notifications, and Reviews Domain
Core entities:
- SupportTicket
- SupportMessage
- Notification
- NotificationPreference
- MerchantReview
- CustomerRating
- Dispute
- CommunicationLog

Store only the information needed for the service and apply appropriate access and retention controls.

## 17. Audit and Security Domain
Core entities:
- AuditEvent
- SecurityEvent
- AccessLog
- DataExportRequest
- ConsentHistory
- RetentionPolicy

Audit records must identify the actor, action, target, timestamp, outcome, and correlation ID. Restrict access to audit data and protect it against unauthorized alteration.

## 18. Multi-Country Readiness
- Country and market configuration.
- Currency and tax configuration.
- Timezone and localization.
- Address formats and regional service rules.
- Market-specific payment and settlement configuration.
- Data residency and retention requirements where applicable.

## 19. Data Ownership Boundaries
Each domain owns its records and business rules. Other domains access data through documented APIs or events rather than directly changing another domain's records.

## 20. Reliability and Performance
- Index frequently queried fields based on measured workloads.
- Use transactions for critical multi-record operations.
- Use idempotency keys for payment and task operations.
- Use an outbox pattern for reliable event publication where needed.
- Back up databases and test restoration regularly.
- Define recovery objectives before production launch.
- Monitor query performance and database capacity.

## 21. Implementation and Acceptance
- Produce an approved entity relationship diagram.
- Define exact field types, constraints, indexes, and relationships.
- Review privacy, access control, and retention requirements.
- Create versioned database migrations.
- Test data integrity, concurrency, backups, and restoration.
- Validate order, inventory, payment, shopper, courier, and handover workflows end to end.

## 22. Implementation Status
This document defines the logical database design only. The production schema, migrations, database infrastructure, and integrations have not yet been implemented.

Project: Outlet Window
Phase: Phase 0 - Database Architecture

## 23. Identity persistence and access-control adapter boundary
The domain package defines database-agnostic ports for:
- Creating an identity without duplicating a principal identifier.
- Updating account status with an expected-current-status condition to prevent lost updates.
- Assigning a role with an explicit scope and validity window.
- Revoking a session only for the owning principal.
- Reading an identity, time-valid role assignments, and a session by principal/session pair.

Validation rules require human identities to have a valid email or E.164-style phone number; service principals may omit human contact details. Role scopes must be explicit. Branch scope requires a merchant scope; city scope requires a country; platform-wide scope must be explicitly platform-only. Role validity windows use a half-open interval: validFrom is inclusive and validUntil is exclusive.

These are contracts and validation helpers, not authentication. Password hashing, passkeys, MFA, identity-provider integration, session token issuance, database constraints, persistent adapters, and API middleware remain unimplemented. Raw passwords, bearer tokens, OTPs, and recovery secrets must never be stored in these identity records.

## 24. Session security and token lifecycle
The domain package defines a storage boundary for sessions:
- Store only a cryptographic digest of an opaque bearer token; never persist the raw token.
- Bind every session to its principal and a session family.
- Validate absolute expiry, idle expiry, revocation, principal ownership, and allowed authentication methods.
- Rotate a session using compare-and-swap against the active prior session and its expected token digest.
- Revoke the complete session family on logout/security events/token-reuse detection/password reset.
- Keep token generation, hashing, secure cookie policy, and cryptographic primitives in approved infrastructure adapters.

The current code supplies contracts and validation only. It does not issue tokens, hash secrets, set cookies, perform password/passkey authentication, implement MFA, detect token reuse by itself, or persist/revoke sessions in a live database. The production adapter must make rotation and family revocation atomic and audit every security-sensitive outcome.
