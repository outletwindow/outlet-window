# Outlet Window — Dispatch & Routing Engine

Version: 1.0
Status: Draft — Pending Technical Review

## 1. Purpose
Design the central engine responsible for assigning, coordinating and tracking order fulfillment tasks across merchants, shoppers, couriers and delivery partners.

## 2. Core Architecture
- Dispatch Engine owns task allocation and assignment decisions.
- Workforce Operations owns worker profiles, eligibility and task participation.
- Order Management owns order and suborder states.
- Inventory owns stock reservations and availability.
- Merchant Order Management owns merchant preparation tasks.
- Routing Engine calculates routes and estimated travel times.
- Unified Handover owns custody transfer evidence.
- AI recommends assignments under approved rules.

## 3. Worker Types
- Mall Personal Shopper.
- Store Employee Shopper.
- Independent Shopper.
- Mall Collector.
- Courier.
- External Delivery Partner.

Each worker has a defined role, permissions, eligibility and service area.

## 4. Assignment Inputs
- Worker availability and active status.
- Current location when authorized.
- Distance to pickup and delivery.
- Vehicle type and capacity.
- Task type and required skills.
- Number of stores and items.
- Estimated task duration.
- Worker workload.
- Customer delivery deadline.
- Safety and service constraints.

## 5. Shopper Assignment
- Assign collection and preparation tasks to eligible shoppers.
- Show task scope and compensation before acceptance.
- Store employees may only prepare orders for their authorized store unless separately permitted.
- Multi-store shopping tasks may be assigned to eligible Mall Personal Shoppers.
- Prevent overlapping assignments beyond configured capacity.
- Respect working hours, contracts and local labor rules.

## 6. Courier Assignment
- Assign pickup and delivery tasks to eligible couriers.
- Verify vehicle capacity and package dimensions.
- Consider distance, workload, service zone and estimated arrival.
- Support motorcycles, cars and approved delivery vehicles.
- Prevent assignment to unavailable or ineligible couriers.
- Support reassignment with an auditable reason.

## 7. Multi-Store Coordination
- Split parent orders into suborders.
- Coordinate preparation readiness across stores.
- Allow separate shoppers or collectors where appropriate.
- Support consolidated pickup when operationally feasible.
- Coordinate one or more couriers based on route and capacity.
- Preserve independent suborder tracking.

## 8. Routing Engine
- Calculate road routes when mapping data is available.
- Support multiple pickup and delivery stops.
- Estimate arrival times using available traffic data.
- Respect vehicle restrictions and service zones.
- Recalculate routes when a valid operational change occurs.
- Clearly distinguish estimated from actual travel times.

## 9. Assignment Lifecycle
1. TASK_CREATED
2. ELIGIBILITY_CHECK
3. CANDIDATE_SELECTION
4. OFFER_SENT
5. ACCEPTED
6. ASSIGNED
7. IN_PROGRESS
8. COMPLETED

Exception states:
- DECLINED
- EXPIRED
- CANCELLED
- REASSIGNMENT_REQUIRED
- WORKER_UNAVAILABLE
- TASK_BLOCKED

## 10. Batching and Optimization
- Group compatible tasks when this improves efficiency.
- Respect package capacity and delivery deadlines.
- Avoid unfair workload concentration.
- Avoid unsafe or unrealistic schedules.
- Never combine tasks that violate merchant, customer or legal constraints.
- Simulations must not change live dispatch rules automatically.

## 11. Worker Fairness and Safety
- Publish compensation and task requirements before acceptance.
- Track cancellations and reassignment reasons.
- Do not impose automatic penalties based solely on AI predictions.
- Provide a review process for disputed task outcomes.
- Collect location only for authorized operational purposes.
- Respect worker privacy and applicable labor regulations.

## 12. Failure Handling
- Handle missed offers and expired assignments.
- Retry safely without duplicate task creation.
- Escalate unavailable workers.
- Recalculate routes when needed.
- Notify affected parties of material changes.
- Provide manual operational intervention.

## 13. Monitoring and Analytics
- Assignment acceptance rate.
- Time to assignment.
- Pickup waiting time.
- Shopper task duration.
- Courier utilization.
- Delivery completion rate.
- Reassignment rate.
- On-time performance.
- Cost per completed task.
- Worker earnings and workload distribution.

## 14. Security and Audit
- Role-based access control.
- Assignment actions require authorized identities.
- Location access is limited and audited.
- All assignments and reassignment decisions are traceable.
- AI agents cannot grant themselves permissions.
- Sensitive actions require configured approvals.

## 15. Acceptance Criteria
- Only eligible workers receive offers.
- Shopper and courier responsibilities remain separate.
- Vehicle capacity is validated.
- Multi-store orders are coordinated correctly.
- Duplicate assignments are prevented.
- Reassignment preserves audit history.
- Routing respects operational constraints.
- Compensation is visible before task acceptance.
- Automated tests cover failure and recovery scenarios.

## 16. Implementation Status
Specification only. No live worker allocation, GPS tracking, mapping integration or dispatch service is claimed.
