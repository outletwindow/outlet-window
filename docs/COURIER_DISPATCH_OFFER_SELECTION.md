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


## Persisted courier eligibility (migration 0067)

Acceptance now uses `PostgresCourierDispatchOfferEligibility` by default in the PostgreSQL API composition root. It rechecks all of the following on the same transaction client before creating a delivery task:

- The courier has an active IAM identity and an active, verified `courier_profiles` record.
- Availability is explicitly enabled and its heartbeat was updated within the last two minutes.
- The courier has an active, verified vehicle whose type is allowed and whose weight and volume capacities meet the dispatch requirement.
- The courier has an active, approved membership in the exact merchant tenant's service area.
- The courier's active task count is below the profile's configured concurrent-task limit.

The profile and availability rows are locked during the check, serializing simultaneous acceptance attempts by the same courier. The workload count includes active assignments across tenants, so a courier cannot exceed their global concurrent-task limit by accepting work from multiple merchants.

Migration `0067_courier_profiles_and_dispatch_eligibility` adds the profile, availability, vehicle, service-area membership and trusted per-suborder dispatch-requirement tables. Dispatch requirements are immutable snapshots and must be written by the trusted dispatch service; merchant-editable suborder metadata is not used as an authority for vehicle or package requirements.

Provisioning remains an administrative workflow: a courier must have an IAM identity, be reviewed and verified, have a verified vehicle, an approved service-area membership, and a fresh availability heartbeat. No default courier or test eligibility is seeded in production. Until those records and a dispatch requirement exist, acceptance safely returns an ineligible result. Availability must be refreshed at least every two minutes.


## Courier availability API

Authenticated couriers with the `courier.delivery_task:update` grant can call `PUT /api/v1/courier/availability` with exactly one field: `available: true|false`. The courier ID is always taken from the authenticated principal; client-supplied courier IDs are rejected.

Going online requires an active IAM identity, an active and verified courier profile, and at least one active verified vehicle. The server persists the availability heartbeat timestamp. Dispatch eligibility considers a courier online only while that heartbeat is no older than two minutes, so the courier application must refresh it periodically while online. Going offline is permitted even when the profile or vehicle is no longer eligible, allowing suspended or deactivated couriers to clear their online state.

Responses distinguish a missing profile (404) from a profile that cannot go online (409). This endpoint does not approve profiles, vehicles, or service-area memberships; those remain controlled review operations.


## Platform courier onboarding API

Platform owners and platform administrators with the platform-scoped `platform.courier_profile` grants can use:

- `GET /api/v1/platform/couriers` to list profiles, optionally filtered by `pending`, `active`, or `suspended`.
- `POST /api/v1/platform/couriers` to create a pending profile for an existing active human IAM identity. The endpoint never creates or activates an IAM identity and never trusts a role supplied by the caller.
- `POST /api/v1/platform/couriers/:courierId/review` with `approve`, `reject`, `suspend`, or `reinstate`. Invalid state transitions fail with 409.

Approval is recorded with the reviewing administrator and timestamp. Suspending or rejecting a courier also forces persisted availability offline. The create and review endpoints require the durable audit writer and append requested plus outcome events. Vehicle verification and service-area membership administration are still separate follow-up work; a profile approval alone does not make a courier eligible to accept dispatch offers.
