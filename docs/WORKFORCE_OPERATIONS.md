# Outlet Window — Workforce Operations

Version: 1.0
Status: Draft for Phase 0
Project: Outlet Window

## 1. Purpose

Define the operational model for all human workers participating in Outlet Window, including couriers, shoppers, store employees and mall collectors.

The system must coordinate tasks, eligibility, availability, compensation, evidence, safety and performance while respecting local employment laws and contractual obligations.

## 2. Workforce Roles

| Role | Primary Responsibility |
|---|---|
| Courier | Transport and deliver collected orders |
| Mall Personal Shopper | Collect products from multiple stores |
| Store Employee Shopper | Prepare orders for the employee's authorized store |
| Independent Shopper | Complete authorized shopping tasks |
| Mall Collector | Collect customer-purchased bags or approved purchases |
| Mall Coordinator | Coordinate authorized collection points and mall operations |
| Workforce Administrator | Manage workforce policies and operational oversight |

A person may qualify for more than one role, but each task must have one explicitly assigned role and permission set.

## 3. Separate Applications

### Courier App
- Registration and identity verification.
- Vehicle type and capacity.
- Availability and service zones.
- Delivery task offers.
- Pickup and delivery instructions.
- Navigation and authorized active-task location sharing.
- Customer communication when permitted.
- Proof of pickup and delivery.
- Earnings and payment history.
- Incident reporting and support.

### Shopper App
- Registration and eligibility verification.
- Shopper type and permitted working locations.
- Available shopping and collection tasks.
- Task reward and estimated effort before acceptance.
- Store and product instructions.
- Barcode and SKU scanning.
- Variant, size, color and quantity verification.
- Bag and receipt evidence.
- Handover confirmation.
- Earnings and task history.
- Incident reporting and support.

### Merchant Portal
- Store-specific order preparation.
- Picking and packing tasks.
- Product and quantity verification.
- Ready-for-collection status.
- Handover to an authorized shopper or courier.
- Exceptions and unavailable products.

## 4. Workforce Registration and Eligibility

Before receiving tasks, workers must complete applicable requirements:

- Identity verification.
- Contact verification.
- Role-specific eligibility checks.
- Required licenses and permits.
- Vehicle and insurance checks where applicable.
- Contractual acceptance.
- Safety training.
- Payment account verification through approved processes.

Eligibility must be configurable by country, city, role and task type.

## 5. Availability and Scheduling

- Workers can set availability where permitted.
- Task offers must respect declared availability.
- Scheduled tasks must show their expected time window.
- The platform must not assign tasks that conflict with known accepted tasks.
- Breaks, working-hour limits and rest requirements must follow applicable law.
- Workers must be able to report temporary unavailability.
- No task should be assigned outside a worker's authorized service area without approval.

## 6. Task Marketplace

Every task must include:

- Unique task ID.
- Task category and required role.
- Pickup and destination locations.
- Merchant and branch details where relevant.
- Expected workload and distance.
- Required vehicle or equipment.
- Estimated time.
- Compensation and applicable deductions.
- Required evidence.
- Acceptance deadline.
- Cancellation and exception rules.

Workers must see the compensation and essential conditions before accepting.

## 7. Shopper Task Types

### A. Mall Personal Shopper
- Collects products from multiple authorized stores.
- Verifies product, variant, size, color and quantity.
- Scans barcodes where available.
- Records unavailable or substituted items.
- Captures required bag and receipt evidence.
- Transfers collected products to the designated handover point.

### B. Store Employee Shopper
- Receives tasks belonging to the employee's authorized store.
- Picks and verifies products.
- Packs orders according to merchant procedures.
- Marks orders ready for collection.
- Hands orders to an authorized recipient.
- Cannot access unrelated merchant inventory or orders.

### C. Independent Shopper
- Accepts eligible tasks from the task marketplace.
- Operates only within authorized locations and task boundaries.
- Must follow product verification and evidence procedures.
- Cannot make unauthorized substitutions or purchases.

### D. Mall Collector
Supports two distinct workflows:

1. Customer-paid collection:
   - Customer purchases and pays the store directly.
   - Collector receives the bags after validating the collection details.
   - Collector transfers the bags to the customer or an approved delivery point.

2. Authorized purchase on behalf of the customer:
   - Customer approves products, prices and total amount.
   - The system records the approved purchase limit.
   - Shopper purchases only within the approved authorization.
   - Receipt and payment evidence are captured.
   - Any material price or product difference requires customer approval.

## 8. Scan & Shop

- Customer scans product barcodes using the application.
- Product details and available variants are displayed.
- Customer selects size, color and quantity.
- Selected products are added to the shopping cart.
- Customer reviews and pays through the approved checkout.
- Store employee or authorized Outlet Window shopper collects and prepares the order.
- The shopper does not purchase on behalf of the customer in this workflow.
- Inventory and price must be revalidated before order confirmation.

## 9. Courier Task Workflow

1. Dispatch identifies eligible couriers.
2. Courier receives a task offer.
3. Courier reviews distance, vehicle requirements and compensation.
4. Courier accepts or declines.
5. Courier proceeds to the authorized pickup point.
6. Pickup is verified through the handover process.
7. Courier transports the package.
8. Customer receives permitted tracking updates.
9. Delivery is verified through an approved proof method.
10. Task completion and earnings are recorded.

## 10. Shopper-to-Courier Handover

- Shopper confirms the collected products and package count.
- Unified Handover records the transfer of custody.
- Courier verifies the handover and accepts custody.
- Both parties receive a confirmation.
- Missing, damaged or mismatched items create an exception.
- The system must preserve who held each package and when.
- Shopping completion does not automatically mean delivery completion.

## 11. Compensation and Earnings

Compensation rules may consider:

- Distance.
- Number of stores.
- Number of products or bags.
- Estimated task duration.
- Waiting time.
- Vehicle type.
- Special handling requirements.
- Delivery difficulty.
- Approved bonuses and incentives.

Requirements:
- Show estimated compensation before task acceptance.
- Record the calculation inputs.
- Show gross earnings, deductions and net earnings separately.
- Maintain an auditable earnings ledger.
- Explain adjustments and provide a dispute process.
- Do not change compensation retroactively without a documented lawful basis.

Final rates must be established through market testing and legal review.

## 12. Workforce Safety and Employment Compliance

- Respect local employment, contractor and platform-work rules.
- Do not assume that every registered worker is an independent contractor.
- Do not assign tasks that conflict with employment obligations.
- Store employees must work within their authorized employer duties.
- Security personnel must not use employer authority, uniform or restricted access for private tasks.
- Security personnel must not perform platform tasks during duty hours unless explicitly authorized and legally permitted.
- Provide incident reporting and emergency support.
- Apply appropriate insurance and occupational safety requirements.

## 13. Performance and Quality

Track relevant indicators such as:

- Task acceptance and completion.
- On-time performance.
- Product and quantity accuracy.
- Pickup and delivery evidence quality.
- Customer feedback.
- Merchant feedback.
- Incident frequency.
- Disputed tasks.
- Task duration and waiting time.

Performance indicators must be contextual and should not automatically trigger unfair penalties.

AI may identify patterns and recommend coaching or investigation. High-impact disciplinary decisions require human review and an appeal process.

## 14. Cancellations and Exceptions

Support documented workflows for:

- Worker cancellation.
- Customer cancellation.
- Merchant unavailable.
- Product unavailable.
- Incorrect product or quantity.
- Damaged package.
- Store closure.
- Delayed collection.
- Courier unavailable.
- Failed handover.
- Failed delivery.
- Safety incident.

Each exception must record its reason, responsible party where known, evidence and resolution.

## 15. Workforce Permissions and Security

- Workers can access only their assigned tasks and necessary information.
- Shoppers cannot access unrelated customer accounts or merchant records.
- Couriers cannot modify product prices or payment records.
- Store employees are restricted to authorized store operations.
- Precise location access must be purpose-limited.
- Sensitive actions must be authenticated and audited.
- Worker access must be revoked or suspended through an authorized process.

## 16. AI Workforce Assistance

AI may:
- Recommend task assignments.
- Estimate task duration and workload.
- Detect operational bottlenecks.
- Suggest compensation models.
- Identify unusual patterns.
- Provide task instructions and multilingual assistance.
- Predict staffing requirements.
- Recommend training and operational improvements.

AI must not independently:
- Impose final disciplinary penalties.
- Withhold earned compensation.
- Permanently deactivate a worker.
- Make unsupported allegations of fraud.
- Override legal employment rights.
- Change approved compensation rules without authorization.

## 17. Workforce System Ownership

- Workforce Management owns worker profiles, roles and eligibility.
- Shopper Task Management owns shopper tasks and completion.
- Courier Management owns courier profiles and vehicle eligibility.
- Dispatch owns courier assignment and delivery coordination.
- Inventory owns stock records.
- Order Management owns order records.
- Unified Handover owns custody transfers.
- Payments & Ledger owns payment and earnings financial records.
- Audit & Compliance owns audit evidence.

## 18. Acceptance Criteria

- Courier and shopper applications have separate responsibilities.
- All worker roles have documented eligibility and permissions.
- Tasks show compensation before acceptance.
- Shopping and delivery workflows are distinct.
- Store employee access is restricted to authorized stores.
- Scan & Shop follows the customer-paid workflow.
- Mall Collector supports both approved collection models.
- Handover evidence is auditable.
- Compensation calculations are traceable.
- Worker safety and employment compliance are considered.
- AI recommendations remain subject to appropriate human oversight.

End of document.
