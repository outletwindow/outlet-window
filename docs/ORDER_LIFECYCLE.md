# Outlet Window — Order Lifecycle Specification

Version: 1.0
Status: Draft — Pending Technical Review
Scope: Local, National and International Orders

## 1. Purpose
Define the complete order lifecycle for Outlet Window across customers, merchants, shoppers, couriers, payments, inventory and handover systems.

## 2. Core Principles
- Order Management is the source of truth for order status.
- Inventory owns stock availability and reservations.
- Payments owns payment, capture and refund status.
- Merchant Order Management owns merchant preparation.
- Workforce Operations manages shopper and courier assignments.
- Unified Handover owns physical custody transitions.
- Audit records every significant transition.
- AI may recommend actions but cannot bypass approvals or legal rights.

## 3. Main Order States
1. DRAFT — Customer is building a cart.
2. PENDING_VALIDATION — Verify prices, products, serviceability and stock.
3. AWAITING_PAYMENT — Payment authorization or collection is pending.
4. CONFIRMED — Payment and stock requirements have been satisfied.
5. MERCHANT_ACCEPTANCE_PENDING — Merchant confirmation is required.
6. PREPARING — Merchant or authorized shopper prepares products.
7. READY_FOR_PICKUP — Products are ready for collection.
8. PICKUP_IN_PROGRESS — Authorized courier or collector is collecting.
9. IN_TRANSIT — Products are being transported.
10. OUT_FOR_DELIVERY — Final delivery is underway.
11. DELIVERED — Delivery proof has been validated.
12. COMPLETED — Financial and operational completion checks have passed.

## 4. Exception States
- ON_HOLD — Temporary operational or compliance hold.
- STOCK_UNAVAILABLE — Requested stock is unavailable.
- PAYMENT_FAILED — Payment attempt failed.
- MERCHANT_REJECTED — Merchant cannot fulfill the order.
- DELIVERY_FAILED — Delivery attempt failed.
- CANCELLATION_REQUESTED — Cancellation is under review.
- CANCELLED — Order cancellation has been finalized.
- RETURN_REQUESTED — Customer has requested a return.
- RETURN_IN_PROGRESS — Return logistics are underway.
- RETURNED — Return handover is confirmed.
- REFUND_PENDING — Eligible refund is being processed.
- REFUNDED — Payment provider has confirmed refund completion.
- DISPUTED — An unresolved dispute exists.

## 5. Multi-Merchant Orders
A customer checkout may generate multiple suborders.
Each suborder has its own merchant, branch, preparation, fulfillment and handover status.
The parent order aggregates suborder progress without overwriting individual statuses.

## 6. Shopper Workflow
- Shopper eligibility and assignment are verified.
- Shopper sees task scope and compensation before accepting.
- Shopper collects or prepares only authorized products.
- SKU, size, color and quantity are checked.
- Shopper captures required evidence.
- Handover requires server-side verification.
- Shopper cannot approve their own payment or bypass custody checks.

## 7. Courier Workflow
- Courier eligibility, vehicle capacity and service area are checked.
- Assignment follows approved dispatch rules.
- Pickup uses a short-lived, single-use QR or equivalent secure proof.
- Each custody transfer is independently recorded.
- Customer tracking is limited to authorized delivery activity.
- Delivery proof is validated before marking DELIVERED.

## 8. Payment and Inventory Controls
- Stock and price are revalidated before confirmation.
- Reservation expiry and payment authorization expiry are handled explicitly.
- Capture, settlement and refunds remain owned by Payments.
- No refund or charge is created merely by changing an order status.
- Failed workflows must use safe retry and reconciliation procedures.

## 9. Cancellation, Returns and Disputes
- Cancellation eligibility depends on actual fulfillment progress and applicable law.
- Customer rights cannot be overridden by AI.
- Returns may require reverse logistics and verified custody transfer.
- Refund decisions and refund execution are separate operations.
- Disputes require auditable evidence and human escalation where appropriate.

## 10. Events and Reliability
Important events include:
- OrderCreated
- OrderValidated
- PaymentAuthorized
- InventoryReserved
- OrderConfirmed
- MerchantAccepted
- PreparationCompleted
- ShopperAssigned
- CourierAssigned
- PickupVerified
- CustodyTransferred
- DeliveryConfirmed
- CancellationRequested
- ReturnRequested
- RefundConfirmed

All events require unique IDs, timestamps, authorization context, idempotency and retry controls.
Event consumers must not create duplicate payments, assignments or custody records.

## 11. Security and Audit
- Role-based access control.
- Least-privilege permissions.
- Immutable or tamper-evident audit history.
- No credentials or payment secrets in logs.
- Sensitive transitions require additional verification.
- AI actions follow the Owner Control Center governance rules.

## 12. Acceptance Criteria
- A valid order can progress from checkout to completion.
- Multi-merchant orders maintain independent suborder states.
- Failed payments cannot produce unauthorized fulfillment.
- Unavailable stock cannot be silently substituted.
- Shopper and courier handovers are verified.
- Duplicate events do not duplicate financial transactions.
- Cancellations and returns preserve customer rights.
- Every critical transition is traceable.
- Automated tests cover successful and failed workflows.

## 13. Implementation Status
Specification only. No production implementation or external integration is claimed.
