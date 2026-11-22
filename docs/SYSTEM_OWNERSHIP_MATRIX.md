# Outlet Window — System Ownership Matrix

Version: 1.0
Status: Draft for Phase 0
Project: Outlet Window

## 1. Purpose

This document defines the ownership boundaries of every major system in Outlet Window. Each system must have one authoritative owner for its core data and business rules.

Other systems may consume data through approved APIs and events, but must not independently modify another system's authoritative records.

## 2. Core System Ownership

| System | Owns | Must Not Own |
|---|---|---|
| Customer App | Customer-facing experience and preferences | Orders, inventory, payments |
| Courier App | Courier task interface, location sharing during active tasks | Dispatch decisions, payment ledger |
| Shopper App | Shopper tasks, collection and scanning workflow | Courier delivery and merchant inventory authority |
| Merchant Portal | Merchant-facing order preparation and branch operations | Platform-wide order state or payment ledger |
| Admin Portal | Authorized administration and oversight | Direct uncontrolled database changes |
| Owner Control Center | Owner commands, approvals, governance and oversight | Bypassing system permissions |
| AI Command Engine | AI task planning, tool selection and execution requests | Unrestricted production access |
| Telegram Bot | Secure command and notification channel | Source of truth or independent authorization |
| Identity & Access | Accounts, roles, permissions and sessions | Business transaction ownership |
| Merchant Management | Merchant profiles, contracts and branch relationships | Product stock quantities |
| Catalog | Product definitions, variants and product attributes | Branch stock balances |
| Inventory | Stock levels, reservations and stock movements | Customer payments |
| Order Management | Orders, order lines, suborders and order lifecycle | Actual payment settlement |
| Pricing & Promotions | Prices, fees, discounts and promotion rules | Payment transactions |
| Payments & Ledger | Payment records, refunds, settlements and financial ledger | Product fulfillment |
| Dispatch | Assignment and coordination of delivery tasks | Inventory or payment ownership |
| Shopper Task Management | Shopper task assignment and completion | Courier delivery execution |
| Courier Management | Courier profiles, eligibility and vehicle information | Order financial records |
| Unified Handover | Custody transfers and handover evidence | Order totals or payment amounts |
| Invoice Intelligence | Invoice extraction, OCR and invoice evidence | Changing paid amounts or order contents |
| Customer Location | Saved customer addresses and location preferences | Historical order address snapshots |
| Notifications | Message delivery and notification status | Business transaction decisions |
| Returns & Refunds | Return cases and refund workflow coordination | Payment execution ledger |
| Customer Support | Support conversations and case records | Unapproved financial or operational changes |
| Analytics & BI | Read models, metrics and reports | Authoritative transaction updates |
| Audit & Compliance | Immutable audit events and compliance evidence | Editing business transactions |
| Feature Control | Feature availability by market, city and account | Bypassing legal or security controls |

## 3. Shopper and Courier Separation

### Courier
- Receives delivery assignments through Dispatch.
- Collects packages and transports them.
- Shares location only during authorized active tasks.
- Records pickup and delivery evidence.
- Cannot alter product prices, order contents or payment records.

### Shopper
- Receives shopping and collection tasks through Shopper Task Management.
- Scans products and verifies variants and quantities.
- Records bags, receipts and collection evidence.
- Cannot perform courier delivery tasks unless separately registered and authorized as a courier.
- Store employees are restricted to their own store unless explicitly authorized.

### Shared Workforce Rules
- A person may register as a shopper, courier or both, subject to eligibility.
- Each task has a specific role, permissions and audit trail.
- The system must never confuse shopping completion with delivery completion.

## 4. Merchant and Inventory Boundaries

- Merchant Portal manages merchant-facing workflows.
- Inventory remains the authority for stock quantities and reservations.
- Catalog remains the authority for product definitions.
- Order Management remains the authority for confirmed customer orders.
- Merchant updates must be validated before changing inventory.
- Every inventory update must retain its source and timestamp.

## 5. Financial Ownership

- Payments records actual payment and refund execution.
- Ledger records financial entries using double-entry accounting.
- Order Management records what the customer ordered.
- Invoice Intelligence records what the invoice states.
- Unified Handover records what was physically transferred.
- Differences between these records must create an exception for review.

## 6. AI and Human Approval

AI agents may:
- Read authorized data.
- Analyze and recommend actions.
- Create development tasks and draft code changes.
- Run approved tests and security checks.
- Execute explicitly permitted low-risk operations.

AI agents must not independently:
- Transfer or withdraw money.
- Change payment or banking settings.
- Delete production data.
- Grant themselves additional permissions.
- Disable audit logging or security controls.
- Publish high-impact production changes without required approval.
- Make final legal or regulatory decisions.

## 7. Integration Rules

1. Systems communicate through documented APIs and events.
2. Each authoritative write must be validated by its owning system.
3. Events must have unique identifiers and support idempotent processing.
4. Sensitive operations must be authenticated, authorized and audited.
5. Cross-system failures must be recoverable without duplicate transactions.
6. Read-only reporting must not modify authoritative records.

## 8. Change Governance

Any change to system ownership requires:
- A documented proposal.
- Impact analysis.
- Security and data review.
- Approval by the authorized project owner.
- An updated version of this document.
- Tests confirming that ownership boundaries remain enforced.

## 9. Acceptance Criteria

- Every core business entity has one authoritative owner.
- Courier and shopper responsibilities are separate.
- Payment, order, invoice and handover records remain distinct.
- AI agents cannot bypass authorization or approval rules.
- Cross-system communication is documented.
- Ownership changes are auditable.

End of document.
