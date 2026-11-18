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


## Transactional response and assignment

- The PostgreSQL command store locks the selected offer and its merchant suborder in one transaction.
- Declines record a reason, increment the offer version, and append an immutable offer event.
- Expired offers are transitioned to `expired` under the same lock; an expired offer cannot be accepted.
- Acceptance creates the courier delivery task, its initial task event, updates the winning offer, and appends the offer event before committing.
- A database unique partial index allows at most one non-terminal delivery task per tenant/suborder, including across concurrent API instances.
- If no authoritative courier eligibility adapter is configured, acceptance returns `eligibility_unavailable` without creating a task. The adapter must use the transaction client and verify account status, identity verification, availability, service zone, vehicle capacity, and active-task capacity from trusted persisted data.
- API response endpoint: `POST /api/v1/courier/offers/:offerId/respond`. The courier app now lists, accepts, and declines offers with optimistic version checks.

## Remaining production dependency

The repository currently has no durable courier profile/availability/vehicle-capacity source to implement the eligibility adapter against. Until that data model and trusted resolver are supplied, acceptance intentionally remains fail-closed; decline and expiry handling are available. No customer address or personal data is exposed in the offer inbox.
