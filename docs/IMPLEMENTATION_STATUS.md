# Outlet Window - Implementation Status

Last updated: 2026-11-08

## Engineering foundation
- [x] pnpm workspace and TypeScript configuration.
- [x] Fastify API foundation with health and readiness endpoints.
- [x] API foundation tests.
- [x] CI workflow for typecheck, tests, and build.
- [x] Domain package with deny-by-default authorization.
- [x] Authorization tests for tenant and branch isolation.

## Implemented domain contracts (not yet connected to live services)
- [x] Versioned audit event contract with recursive secret redaction and metadata limits.
- [x] API request correlation ID response header.
- [x] Identity lifecycle and session descriptor validation.
- [x] Customer delivery instruction contract: optional contact, doorbell and handover preferences; up to eight photo references; validation and tests.
- [x] Scheduled fulfillment plan: timezone-aware time calculations and capacity validation.
- [x] Scheduled checkout saga decisions and multi-merchant orchestrator: persist provider-confirmed payment evidence, reserve each exact merchant suborder, then enqueue branch-targeted timed tasks; failures block task enqueue and return prior reservation references for explicit compensation/customer choice.
- [x] Scheduled task outbox domain contract and PostgreSQL adapter: idempotent enqueue, lease-token validation, bounded retry scheduling and integration tests.
- [x] Atomic scheduled-order commit port and PostgreSQL transaction adapter: validates payment-capture evidence and coordinates order confirmation plus outbox enqueue in one transaction boundary, with rollback/idempotency tests.
- [x] Scheduled-task reconciliation contract: detects missing, duplicate, unexpected, dead-letter, expired-lease and stale-pending records with tenant-scoped reader port and tests (reader/worker not yet implemented).

## In progress
- [x] PostgreSQL IAM schema migration, persistence adapter, API runtime wiring, and persisted-session actor resolution when DATABASE_URL is configured; ephemeral PostgreSQL CI acceptance passed. Managed production database provisioning remains pending.
- [ ] Authentication, password/passkey flows, MFA, and session revocation.
- [x] PostgreSQL selected; versioned IAM migration and advisory-locked transactional migration runner added and verified in CI. Managed database provisioning and deployment remain pending.
- [ ] Audit event persistence and protected access.
- [ ] Production API authentication and authorization integration across all customer, merchant, shopper, courier, admin and owner data routes.
- [x] API authorization reference route: server-side actor resolver seam, deny-by-default behavior, and merchant/branch isolation tests.
- [x] Persisted-session actor resolution contract: bearer parsing, digest comparison, active identity/session checks, scoped role validation, multiple active roles with independently scoped grants, and injected role-to-grant mapping (concrete crypto and persistence adapters not yet implemented).
- [x] Centralized API authentication/authorization guard shared by protected routes; authentication and scope authorization run before repository availability checks or business-data access. Tests cover unauthenticated requests, scope denial without repository calls, and authorized branch reads.
- [x] Initial PostgreSQL merchant/branch registry migration and tenant-scoped read adapter; API branch summary route uses the PostgreSQL reader by default.
- [x] Authorized merchant-scoped branch creation and update APIs with PostgreSQL writer; validates payloads, rejects cross-merchant writes, does not overwrite duplicates, refuses writes for inactive merchants, and limits create/update grants to merchant owners/admins. Branch update supports safe activation/deactivation and address preservation when omitted. CI coverage added; merchant onboarding and full branch management remain pending.
- [x] PostgreSQL scheduled task outbox persistence, atomic order/payment-capture confirmation handoff, lease-based worker claims, bounded retry/dead-letter handling, and idempotent durable inbox dispatch (CI typecheck, tests, PostgreSQL integration checks, and build passed on `0c037ce`).
- [ ] Scheduled task inbox consumers for merchant preparation, shopper collection, and courier dispatch; operational alert delivery and authorized remediation.
- [ ] Scheduled-task reconciliation reader, recurring worker, alert delivery and authorized remediation workflow.
- [ ] Production transaction adapter and payment-to-order reconciliation/compensation workflow.
- [ ] Payment provider capture/void/refund integration.
- [x] Branch-level inventory ledger, customer order item lines, merchant/branch-scoped reservation records, and PostgreSQL transaction adapter for atomic platform-side stock allocation; integration tests cover idempotency, exact order-line matching, and concurrent final-unit contention.
- [x] Idempotent reservation lifecycle operations for release, expiry, and consumption; release requires a reason, consumption requires verified handover proof, release/expiry restore allocation, and consumption decrements stock.
- [x] Durable provider-confirmed payment evidence can be recorded idempotently before branch inventory reservation. Payment capture itself remains external.
- [ ] Live slot capacity aggregation across branches, shoppers and couriers.

## Not yet implemented
The customer, merchant, shopper, courier, admin, owner, payment, inventory synchronization, dispatch, AI operations, Telegram, and external integration applications are not yet operational. The scheduled outbox-to-inbox worker is implemented on the development branch but preparation, shopper collection, and courier dispatch inbox consumers are pending. A PostgreSQL branch inventory ledger and atomic platform-side reservation adapter exist, but checkout wiring and merchant POS/ERP hard-reservation acknowledgements remain pending. Customer delivery photo uploads, media storage, customer UI, API persistence and courier/pickup integration are not yet operational. Scheduled order booking UI, live slot capacity, payment execution, scheduled expiry processing, stock reconciliation, customer alternative selection and rescheduling are not yet operational.

## Acceptance rule
A checkbox is marked complete only when code is present and automated checks or documented acceptance evidence verify it. A design document or interface alone is not proof of an operational feature.


## PostgreSQL persistence progress (development branch)
- [x] Initial identities, role_assignments, and sessions schema migration with foreign keys, uniqueness constraints, and expiry indexes.
- [x] PostgreSQL IAM repository adapter implementing identity/session reads and transactional writes, session rotation and family revocation.
- [x] API composition root that wires persisted session and identity readers into bearer actor resolution when supplied a configured pool and digest implementation.
- [x] Versioned migration runner with PostgreSQL advisory lock, per-migration transaction, duplicate detection, and rollback on failure.
- [x] Automated migration-runner tests for ordering, repeatability, malformed versions, lock release, and rollback.
- [ ] Provision a persistent managed PostgreSQL instance; CI currently validates the application migration runner against an ephemeral PostgreSQL 16 service.
- [x] Add CI integration checks against a real ephemeral PostgreSQL 16 service for migration execution, identity/role/session persistence, principal isolation, and foreign-key enforcement.
- [x] Add versioned merchant/branch schema and CI tests for tenant-bound branch reads, orphan-branch foreign-key rejection, and unknown branch behavior.
- [x] Add PostgreSQL branch creation/update tests for active merchant inserts, duplicate protection, tenant isolation, and unknown merchant handling; add API authorization and payload validation tests.
- [x] Wire the API server to PostgreSQL when DATABASE_URL is configured; production startup refuses to run without it, readiness checks database connectivity, and graceful shutdown closes the pool.
- [x] Add a CLI migration command using the advisory-locked versioned migration runner; migrations are explicit and are not silently applied by API startup.
- [x] CI acceptance for TypeScript adapter tests covering tenant-bound session reads and concurrent one-time session rotation (run 42404896175 passed typecheck, tests, and build).
- [x] Document the encrypted backup and isolated restore procedure and production acceptance checklist.
- [ ] Configure provider-managed encrypted backups, retention, monitoring, and perform a restore drill in the selected cloud account.


## Branch inventory and reservation progress (development branch)
- [x] Added versioned schema for customer order item lines, branch inventory quantities and freshness/source metadata, reservation headers, and reservation lines.
- [x] Added a PostgreSQL transaction adapter that locks branch stock rows, validates exact merchant suborder lines, reserves all lines or none, and safely returns unavailable variants when stock is missing/insufficient.
- [x] Added idempotency replay/conflict handling and integration tests for simultaneous requests competing for the final unit.
- [ ] Wire checkout to call this adapter after confirmed payment capture; no customer API route or merchant connector is claimed live.
- [ ] Implement stock sync, scheduled expiry worker, reconciliation, and merchant external hard-reservation acknowledgements.


## Reservation lifecycle progress (development branch)
- [x] Added idempotent release, expiry, and consume transitions protected by reservation-row locks and stock-row locks.
- [x] Release/expiry return reserved quantity to available stock; consume decrements both available and reserved quantities exactly once and records the handover reference.
- [x] Expiry cannot run before the configured expiry instant; terminal replays do not adjust stock twice.
- [x] Payment-provider capture evidence can be recorded before inventory reservation and replayed idempotently; no payment provider charge/capture call is performed by this adapter.
- [ ] Wire the checkout saga to call payment evidence persistence, then inventory reservation, then task enqueue in that exact order.

- [x] Reservation finalization schema enforces a release reason or verified handover reference for consumed stock; SQL acceptance tests cover invalid final states.


## Multi-merchant scheduled checkout progress (development branch)
- [x] Scheduled task envelopes can target an exact merchant tenant, suborder, merchant and branch; idempotency keys are scoped by suborder.
- [x] Orchestrator persists provider-confirmed payment evidence first, reserves each branch suborder, and only after every reservation succeeds commits all timed preparation/dispatch tasks together.
- [x] If any branch cannot reserve stock, no preparation/dispatch tasks are enqueued; any earlier successful reservation references are returned for explicit customer-choice/compensation handling.
- [x] Outbox worker validates target shape and inbox publisher verifies the target belongs to the exact order/suborder/merchant/branch before durable inbox insertion.
- [ ] Wire orchestrator to the authenticated checkout API and customer alternative/compensation workflow.
