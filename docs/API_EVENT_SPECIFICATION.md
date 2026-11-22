# Outlet Window - API & Event Specification

## 1. Purpose
Define the API and event communication standards connecting all Outlet Window applications and backend domains.

## 2. API Architecture
- Backend API candidate: REST over HTTPS.
- API style: versioned endpoints under /api/v1.
- Data format: JSON.
- Authentication: secure token-based authentication.
- Authorization: role-based and resource-level access control.
- API documentation: OpenAPI specification.
- Internal services must use authenticated service-to-service communication.

## 3. Applications and API Clients
- Customer Application
- Merchant Portal
- Shopper Application
- Courier Application
- Admin Portal
- Owner Control Center
- Telegram Command Bot
- Approved external merchant and logistics integrations

Each client receives only the endpoints and permissions required for its role.

## 4. API Domain Ownership
- Identity Service: accounts, authentication, roles, and permissions.
- Merchant Service: merchants, branches, and merchant users.
- Catalog Service: products, variants, categories, and barcodes.
- Inventory Service: stock, reservations, and inventory updates.
- Customer Location Service: saved addresses and service eligibility.
- Order Management: orders, suborders, and order status.
- Shopper Service: shopper profiles and shopping tasks.
- Courier Service: courier profiles and delivery assignments.
- Workforce Service: shared task coordination and eligibility.
- Payments Service: payment attempts, refunds, and financial records.
- Unified Handover: custody transfers and verification.
- Invoice Intelligence: invoice extraction and discrepancy records.
- Notification Service: approved customer and workforce notifications.
- AI Orchestration: AI tasks, recommendations, monitoring, and approvals.
- Audit Service: security and operational audit events.

Each domain owns its data and business rules. Other domains must not directly modify its records.

## 5. Main API Workflow Groups

### Identity
- Register and authenticate users.
- Retrieve the current user's profile.
- Manage authorized roles and sessions.
- Request account recovery through approved secure workflows.

### Merchants and Branches
- Register and manage merchant profiles.
- Create and update authorized branches.
- Manage branch operating hours and service areas.
- Manage merchant integrations and permissions.

### Catalog and Inventory
- Browse products and variants.
- Retrieve branch-level availability.
- Submit authorized inventory updates.
- Create and release inventory reservations.
- Record inventory synchronization results.

### Customer and Orders
- Search merchants and products.
- Manage saved addresses and shopping carts.
- Validate cart prices and stock.
- Create parent orders and merchant suborders.
- Retrieve order status and request cancellation or return.

### Shopper Tasks
- Retrieve eligible shopping tasks.
- Accept or decline an offered task.
- Update task progress.
- Scan products and verify variants and quantities.
- Submit approved evidence and request handover.

### Courier Tasks
- Retrieve eligible delivery offers.
- Accept or decline a delivery assignment.
- Submit pickup and delivery status.
- Submit authorized location updates during active tasks.
- Verify pickup and delivery codes.
- Submit delivery proof.

### Payments and Finance
- Create payment requests through approved providers.
- Receive and verify payment status.
- Request refunds through controlled workflows.
- Record settlements and payout status.
- Reconcile financial records.

### Owner Control and AI
- Submit owner commands.
- Create AI analysis and development tasks.
- Retrieve task progress and reports.
- Submit recommendations for approval.
- Record approval decisions.
- Execute only authorized actions.

## 6. Event Communication Standards
Events must have a unique event ID, event type, timestamp, schema version, source domain, entity ID, correlation ID, and payload.

Events must not contain passwords, authentication tokens, payment card data, or unnecessary personal information.

## 7. Core Business Events
- user.registered
- merchant.created
- branch.created
- product.updated
- inventory.updated
- inventory.reserved
- inventory.reservation_expired
- order.created
- order.confirmed
- order.split_into_suborders
- order.cancelled
- payment.succeeded
- payment.failed
- refund.requested
- refund.completed
- shopper.task.offered
- shopper.task.accepted
- shopper.task.completed
- courier.delivery.offered
- courier.delivery.accepted
- courier.pickup.completed
- courier.delivery.completed
- handover.requested
- handover.verified
- invoice.extracted
- invoice.discrepancy.detected
- support.ticket.created
- ai.task.created
- ai.recommendation.created
- approval.requested
- approval.decided
- security.incident.detected

## 8. Order Lifecycle Coordination
1. Customer submits a cart for validation.
2. Inventory revalidates stock and prices.
3. Payment is authorized or completed according to the payment provider workflow.
4. Order Management creates the parent order and required suborders.
5. Merchant and workforce workflows receive their respective tasks.
6. Shopper collects or prepares items when required.
7. Unified Handover records custody transfer.
8. Courier completes delivery when required.
9. Order Management records the final order state.
10. Payments and Finance reconcile the transaction and applicable settlements.

Exact state transitions and compensation workflows must be defined before implementation.

## 9. API Reliability and Error Handling
- Use consistent error response structures.
- Validate all input on the server.
- Apply request timeouts and rate limits.
- Use idempotency keys for sensitive or repeatable operations.
- Prevent duplicate payment, task acceptance, and handover processing.
- Use bounded retries and controlled backoff.
- Use correlation IDs for cross-service tracing.
- Version API contracts and avoid breaking existing clients without a migration plan.

## 10. Security Requirements
- HTTPS for all external API traffic.
- Strong authentication and least-privilege authorization.
- Validate ownership of every requested resource.
- Protect against injection, replay, and unauthorized access.
- Store secrets in a dedicated secrets manager.
- Never expose internal credentials through mobile applications or Telegram.
- Require explicit approval for sensitive owner commands.
- Log security-relevant actions without exposing secrets.

## 11. Telegram Command Bot
Telegram is a command interface, not the source of truth.

All commands must pass through the central identity, authorization, orchestration, and audit services. Sensitive actions require a separate approval workflow. Telegram outages must not stop core commerce or delivery operations.

## 12. Integration Standards
- Use documented APIs and approved webhooks.
- Authenticate incoming webhook requests.
- Verify event signatures where supported.
- Handle duplicate and out-of-order events safely.
- Maintain integration health and failure logs.
- Provide manual operational fallback procedures.

## 13. Testing and Acceptance
- API contract tests.
- Authentication and authorization tests.
- Integration and webhook tests.
- Event delivery and duplicate-processing tests.
- Order-to-delivery end-to-end tests.
- Shopper and courier workflow tests.
- Payment and reconciliation tests.
- Load, rate-limit, and failure-recovery tests.

## 14. Implementation Status
This document defines the intended API and event contracts at a logical level. Exact endpoint paths, request and response schemas, event payload schemas, and production integrations must be specified and reviewed during engineering design. No API services are implemented or active yet.

Project: Outlet Window
Phase: Phase 0 - API and Integration Design
