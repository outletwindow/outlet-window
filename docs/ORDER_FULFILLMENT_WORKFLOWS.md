# Outlet Window — Order Fulfillment Workflows

Version: 1.0
Status: Draft for Phase 0
Project: Outlet Window

## 1. Purpose

Define the complete order lifecycle from customer checkout to final delivery or collection.

The workflows must support multiple merchants, branches, shoppers, couriers, delivery methods, scheduled orders, returns and exceptions.

## 2. Supported Fulfillment Models

1. Immediate local delivery.
2. Scheduled local delivery.
3. Store pickup.
4. Mall personal shopping.
5. Store employee order preparation.
6. Mall collection.
7. Scan & Shop.
8. Multi-store consolidated delivery.
9. Multi-store split delivery.
10. Intercity shipping.
11. International shipping.

Availability depends on market, merchant agreements, operational readiness and legal requirements.

## 3. Order Lifecycle

The general lifecycle is:

1. Cart created.
2. Cart validated.
3. Product prices and inventory rechecked.
4. Delivery options calculated.
5. Customer confirms checkout.
6. Payment authorization or collection completed according to the payment model.
7. Order and merchant suborders created.
8. Inventory reservation requested.
9. Merchant or shopper receives preparation tasks.
10. Products picked and verified.
11. Packages prepared.
12. Unified Handover records custody transfer.
13. Courier or pickup workflow begins.
14. Customer receives the order.
15. Order completion and financial reconciliation are recorded.

Each transition must be validated by the system that owns the relevant business record.

## 4. Multi-Merchant Orders

A single customer cart may contain products from several merchants.

Order Management must:
- Create one customer-facing parent order.
- Split it into merchant-specific suborders.
- Associate each suborder with its merchant and branch.
- Track item quantities and prices independently.
- Calculate fulfillment and delivery options.
- Track each suborder separately.
- Present consolidated order progress to the customer.
- Support partial completion and partial cancellation where permitted.

Each merchant suborder must retain its own operational and financial references.

## 5. Inventory Validation

Before order confirmation:
- Check stock availability at the selected branch.
- Verify product variant, size, color and quantity.
- Validate current product price.
- Record inventory source and last update time.
- Request reservation where supported.

Inventory must not be presented as guaranteed if the merchant integration cannot confirm it.

If stock becomes unavailable:
- Notify the customer.
- Offer another eligible branch or product alternative.
- Show any price or delivery-time difference.
- Obtain customer approval before substitution.
- Refund or release payment according to the applicable payment workflow if the item cannot be fulfilled.

## 6. Immediate Local Delivery

1. Customer selects an eligible address.
2. Platform identifies eligible merchant branches.
3. Inventory is checked.
4. Delivery fee and estimated time are calculated.
5. Customer confirms and pays.
6. Merchant or shopper prepares the order.
7. Pickup is verified.
8. Dispatch assigns an eligible courier.
9. Courier collects the package.
10. Customer tracks the delivery.
11. Delivery is verified.
12. Order is completed.

Eligibility must consider service radius, route distance, vehicle capacity, merchant readiness and operational availability.

## 7. Scheduled Orders and Customer-Selected Time Slots

Customers may select a preferred date and time window for all supported fulfillment modes:
- Home delivery by courier.
- Store/branch pickup.
- Personal shopper collection or handover.

The scheduling engine must:
- Show only slots supported by branch, merchant, shopper and courier capacity.
- Calculate a preparation estimate per cart, branch, fulfillment type and current workload.
- Include packing, store queue, mall walking/collection, consolidation and travel time where applicable.
- Include a configurable safety buffer and avoid promising an exact minute when only a time window is reliable.
- Revalidate slot capacity atomically at checkout to prevent overbooking.
- Use the market's local time zone and preserve the UTC instant; daylight-saving transitions must not create ambiguous bookings.
- Support a configurable horizon up to 90 days, subject to merchant and market capability.

### Payment and early stock reservation

For a confirmed paid booking, the configured payment policy captures/collects the amount at checkout (or authorizes it where the payment method requires later capture). Payment is recorded immediately and idempotently; payment must never be inferred from order status.

As soon as payment succeeds and the order is confirmed, Order Management sends the branch an immediate reservation request. Inventory must attempt an atomic reservation of the exact SKU, size, color and quantity. The merchant receives a reservation notice early, even when the preparation task is scheduled for later. If the merchant integration cannot reserve stock, the customer must see that availability is not guaranteed and the platform must revalidate before the preparation cutoff.

### Preparation release calculation

For a target handover time T:
- Home delivery: preparation release = T − estimated travel time − preparation time − safety buffer. Courier dispatch = T − estimated travel time.
- Store pickup: preparation release = T − preparation time − safety buffer.
- Personal shopper handover/collection: preparation release = T − estimated shopping/collection time − safety buffer. Shopper assignment and task release are scheduled accordingly.

Example: customer books delivery for 17:00, preparation estimate is 30 minutes, travel estimate is 20 minutes, and buffer is zero. The order is created and paid at checkout; the branch is asked to reserve the item immediately. The preparation task is released at 16:10 and courier dispatch at 16:40 to target the 17:00 arrival. For a store pickup at 17:00 with a 30-minute preparation estimate, the branch preparation task is released at 16:30.

The engine must not wait until the preparation cutoff to create the order or reserve stock. Only the operational preparation/dispatch task is delayed. If a booking is made inside the calculated preparation window, release the task immediately and show the customer the earliest realistic available slot.

### Checkout orchestration and task queue

The scheduled checkout saga uses the following guarded sequence:
1. Validate the selected time slot and available capacity.
2. Capture payment immediately after customer confirmation using a provider idempotency key.
3. Create the order and request exact-variant branch reservation immediately.
4. Only after a confirmed reservation, persist timed preparation and dispatch tasks in a durable queue.
5. Release merchant preparation, personal shopper collection or courier dispatch at their calculated UTC instants.
6. Persist each provider/task result and retry idempotently; never create duplicate charges, reservations or assignments.

If payment fails, do not confirm the order or request stock reservation. If stock reservation fails after payment capture, hold fulfillment and show eligible alternatives. If the customer declines or no alternative exists, process a linked full/partial refund according to the payment provider and applicable law. Do not silently substitute or automatically change the customer's selected product.

A payment provider may require authorization/capture rather than immediate capture for a specific payment method. The customer-facing payment disclosure must state the actual behavior; never describe an authorization hold as a completed charge.

### Out-of-stock and alternatives

If the exact item cannot be reserved:
- Do not silently confirm the requested variant as reserved.
- Show alternatives such as another authorized branch, the same product in another eligible variant, or a similar product.
- Display price difference, availability confidence and revised preparation/arrival time.
- Hold the booking in a clear exception/pending-customer-choice state; do not purchase or substitute without approval.
- If the customer declines or no eligible alternative exists, cancel the affected line/order and process the appropriate refund or release under the payment policy and applicable law.

Slot alternatives must also be offered if the requested time has no remaining capacity.

### Notifications and rescheduling

Notify the customer when the slot is confirmed, stock is reserved (or could not be reserved), preparation begins, a courier/shopper is assigned, and the order is ready or approaching handover. A time or price change requires customer approval. Preserve the original booking and every reschedule in the audit history.

## 7A. Customer Delivery Photos and Preferences

Customers may optionally attach up to eight private instruction photos to an order, such as the building entrance, gate, parking bay, vehicle or pickup meeting point. Each photo may have a purpose label and short caption, with an additional access note.

Customers may independently choose:
- Phone call, in-app message, both or neither as preferred contact channels.
- Hand the order directly to the customer or leave at the door for eligible home deliveries.
- Ring the doorbell, do not ring, or no preference.

These preferences are optional and editable before the operational cutoff. They are instructions, not proof of identity or delivery. Leave-at-door is unavailable for store pickup and pickup points. Safety, law, merchant policy and fulfillment capability take precedence; conflicts must be explained rather than silently overridden.

Photos are private order data visible only to the customer and authorized personnel assigned to fulfill the order. Store media asset references rather than raw image bytes in order records. Upload security, retention, deletion and access controls must be implemented by the media service.

## 8. Store Pickup

1. Customer selects a branch offering pickup.
2. Inventory is checked.
3. Customer confirms and pays.
4. Merchant prepares the order.
5. Merchant marks the order ready.
6. Customer receives pickup instructions.
7. Customer arrives at the authorized branch.
8. Pickup identity or code is validated.
9. Merchant records the handover.
10. Order is marked collected.

Pickup should not incur delivery fees unless another service charge is clearly disclosed.

## 9. Mall Personal Shopper Workflow

1. Customer selects products from eligible mall stores.
2. The platform validates prices and availability.
3. Customer confirms the shopping order.
4. Shopper receives the task and reward details.
5. Shopper visits authorized stores.
6. Shopper scans and verifies each product.
7. Unavailable products are reported.
8. Customer approves alternatives where necessary.
9. Shopper records receipts and package evidence.
10. Shopper transfers collected products to the designated handover point.
11. Courier receives custody if delivery is required.
12. Customer receives the order.

The shopper must not make unauthorized substitutions or purchases.

## 10. Store Employee Preparation Workflow

1. Merchant receives a new suborder.
2. Authorized employee accepts or receives the preparation task.
3. Employee picks products from the merchant's own authorized inventory.
4. Employee verifies SKU, variant and quantity.
5. Employee packs the products.
6. Employee records unavailable or damaged items.
7. Employee marks the package ready.
8. Unified Handover verifies transfer to the authorized recipient.

Store employees must not access other merchants' orders without explicit authorization.

## 11. Mall Collector Workflow

### Customer-paid collection

- Customer pays the store directly.
- Collector receives the collection request.
- Store validates the collection reference.
- Collector receives the bags.
- Collector records package evidence.
- Bags are delivered to the agreed meeting point, vehicle or customer address.

### Approved purchase on behalf of customer

- Customer reviews the requested products.
- Customer approves the prices and spending limit.
- Shopper receives the authorized purchase task.
- Shopper purchases only the approved items.
- Shopper records the receipt and actual amount.
- Any material difference requires customer approval.
- Financial reconciliation follows the approved payment model.

These workflows must remain distinguishable in the order record.

## 12. Scan & Shop Workflow

1. Customer opens the continuous scanning camera.
2. Customer scans a product barcode.
3. Platform retrieves product information.
4. Customer selects available size, color and quantity.
5. Product is added to the active cart.
6. Scanning continues without closing the cart session.
7. Customer reviews all selected items.
8. Prices and inventory are revalidated.
9. Customer pays through Outlet Window.
10. Merchant employee or authorized shopper receives preparation tasks.
11. Products are collected, verified and packed.
12. Unified Handover records custody transfer.
13. Customer collects the order or receives delivery.

The shopper does not purchase products on behalf of the customer in this workflow.

## 13. Multi-Store Delivery Strategies

The platform must support:

### A. Separate deliveries
Each merchant suborder receives its own delivery task and ETA.

### B. Consolidated delivery
Products from multiple merchants are collected and transferred to an authorized consolidation point before final delivery.

### C. Multiple couriers
Different couriers may handle different legs or merchant pickups.

The customer must see:
- Delivery method.
- Estimated arrival window.
- Delivery fee.
- Number of packages or deliveries where known.
- Any additional waiting or consolidation time.

Consolidation must not occur unless operationally supported and custody is recorded.

## 14. Intercity and International Shipping

- Validate origin and destination service coverage.
- Select eligible shipping providers.
- Calculate shipping costs and estimated delivery times.
- Capture shipment dimensions and weight.
- Record tracking references.
- Support customs documentation where applicable.
- Show duties, taxes and import fees according to the applicable commercial and legal model.
- Track shipment events.
- Handle lost, damaged, delayed or returned shipments.

International shipping must remain disabled in markets where legal, tax or operational requirements are not satisfied.

## 15. Order Changes

Changes after confirmation must trigger validation of:
- Inventory.
- Price.
- Delivery fee.
- Delivery time.
- Merchant acceptance.
- Payment difference.

The customer must approve material changes before they take effect.

Historical order details must not be silently overwritten.

## 16. Cancellation Workflow

Cancellation eligibility depends on the current order state and applicable law.

The workflow must:
- Record the cancellation request.
- Identify completed and in-progress fulfillment tasks.
- Determine which items or services can still be cancelled.
- Calculate any legally permitted charges.
- Release inventory reservations where applicable.
- Initiate refunds through Payments when due.
- Notify affected merchants, shoppers and couriers.
- Preserve an audit trail.

AI may recommend a cancellation outcome but must not override customer rights or make final legal determinations.

## 17. Returns and Exchanges

Support:
- Full returns.
- Partial returns.
- Size exchanges.
- Color or variant exchanges.
- Damaged or incorrect items.
- Merchant-specific return policies.
- Applicable statutory consumer rights.

The workflow must:
1. Receive the request.
2. Validate order and item details.
3. Display the applicable policy and legal rights.
4. Collect evidence when relevant.
5. Determine the return method.
6. Coordinate pickup or branch return.
7. Record physical receipt.
8. Inspect and resolve the case.
9. Initiate the approved refund or exchange.
10. Notify the customer.

A merchant policy must not override mandatory consumer protection rights.

## 18. Unified Handover and Custody

Every physical custody transfer must record:
- Order and package identifiers.
- Sender and recipient identities or authorized roles.
- Date and time.
- Transfer location.
- Package count.
- Verification method.
- Required evidence.
- Exceptions or discrepancies.

QR codes must be unique, short-lived and validated by the server.

A handover code must be consumed atomically to prevent reuse.

Shopping completion, package readiness, courier pickup and customer delivery are distinct events.

## 19. Exception Management

The platform must support:
- Merchant rejection.
- Stock mismatch.
- Product unavailable.
- Price change.
- Preparation delay.
- Shopper unavailable.
- Courier unavailable.
- Failed pickup.
- Failed handover.
- Customer unavailable.
- Damaged package.
- Incorrect product.
- Payment failure.
- Refund failure.
- Route disruption.
- Store closure.

Each exception must include a reason, timestamp, responsible system and resolution status.

## 20. Customer Notifications

Notify customers about relevant events:
- Order confirmed.
- Payment status.
- Merchant acceptance.
- Preparation started.
- Product unavailable.
- Customer approval required.
- Package ready.
- Courier assigned.
- Pickup completed.
- Delivery approaching.
- Delivery completed.
- Cancellation or refund status.
- Return or exchange progress.

Notifications must avoid exposing sensitive information.

## 21. Operational and Financial Reconciliation

The following sources of truth remain separate:

- Order Management: what the customer ordered.
- Inventory: what stock was available and reserved.
- Payments & Ledger: what was actually paid, refunded or settled.
- Invoice Intelligence: what the invoice states.
- Unified Handover: what was physically transferred and received.

Any discrepancy must create an auditable exception.

No AI agent or workflow may silently change one source to match another.

## 22. Acceptance Criteria

- Parent orders and merchant suborders are supported.
- Each fulfillment model has a documented workflow.
- Inventory and price are revalidated at the appropriate stages.
- Scheduled orders include reservation or revalidation rules.
- Shopper and courier responsibilities remain separate.
- Multi-store delivery strategies are supported.
- Custody transfers are recorded.
- Cancellations, returns and exchanges preserve legal rights.
- Payment and invoice evidence remain distinct.
- Exceptions and notifications are traceable.
- Every workflow has testable state transitions.

End of document.
\n\n## Implementation boundary — inventory reservation (development branch)\nThe repository now contains a PostgreSQL branch inventory ledger, exact customer order item lines, and an atomic platform-side reservation adapter. The adapter requires the paid-order confirmation evidence and exact merchant suborder, then locks and allocates every requested variant in one transaction. Missing or insufficient stock returns an unavailable result; it does not silently substitute. The adapter is not yet wired into checkout, and an internal platform reservation is not represented as an external POS/ERP acknowledgement.\n

## Multi-merchant scheduled checkout orchestration (development branch)
A domain orchestrator now persists payment-provider capture evidence, then reserves each merchant suborder's exact branch/SKU lines, and only after all reservations succeed atomically enqueues branch-targeted preparation and dispatch tasks. Each task carries merchant tenant, suborder, merchant and branch references; task idempotency keys include the suborder. If any reservation is unavailable or unguaranteed, timed tasks are not enqueued and earlier successful reservation references are returned for customer choice or explicit compensation. This orchestrator is not yet connected to a customer-facing checkout route.


## Durable task consumer foundation
A recoverable inbox consumer framework now supports due-task claiming, expired lease recovery, idempotent handler dispatch, bounded retry, dead-letter and stale-worker protection. Concrete merchant, shopper and courier connectors are still pending, so no real preparation, collection or courier assignment is yet performed by this worker framework.
