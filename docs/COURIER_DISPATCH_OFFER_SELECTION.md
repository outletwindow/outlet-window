# Courier Dispatch Offer Selection

Status: Implemented domain primitive; not a live dispatch service.

## Implemented
- Fail-closed eligibility filtering for active, verified and available couriers.
- Service-zone matching and accepted vehicle-type matching.
- Package weight and volume capacity checks.
- Active-task concurrency limit checks.
- Deterministic shortlist ranking by active workload, pickup distance, then courier ID.
- Configurable shortlist size, capped at 100.
- Unit tests for exclusion rules, ranking, shortlist limits and invalid input.

## Safety boundary
This function only recommends courier IDs for task offers. It does not create assignments, reserve capacity, expose customer details, or start location tracking. A future acceptance API must re-check eligibility and capacity inside a database transaction and enforce one active assignment per task. Live dispatch still requires authenticated courier sessions, durable offers/acceptance, expiry, audit events, mapping/ETA provider integration, and provider sandbox tests.


## Offer lifecycle domain guard

- Added a pure, versioned offer state machine for offered, accepted, declined, expired, and cancelled states.
- Only the assigned courier can accept or decline; acceptance requires a fresh caller-supplied eligibility check.
- The system can expire offers only at or after their deadline; dispatchers can cancel only with a reason.
- Stale versions, repeated responses, malformed timestamps, and acceptance after expiry fail closed.
- This is a domain guard, not a live dispatch endpoint or database reservation. Production wiring must lock the offer and task in one transaction, re-check courier capacity, and enforce one accepted assignment per task.
