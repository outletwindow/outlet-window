# Outlet Window - Implementation Status

Last updated: 2026-11-07

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
- [x] Scheduled checkout saga decisions: payment-before-reservation sequence, customer alternative/refund outcomes, idempotency keys and timed task envelopes.
- [x] Scheduled task outbox domain contract: idempotent enqueue port, lease-token validation, bounded retry scheduling and tests (adapter not yet implemented).
- [x] Atomic scheduled-order commit port: validates order/task consistency and coordinates order persistence plus outbox enqueue in one transaction boundary, with rollback/idempotency tests (database adapter not yet implemented).

## In progress
- [x] PostgreSQL IAM schema migration and database-agnostic persistence adapter for identities, scoped roles, and sessions; API composition root can resolve actors from the persistent store when a configured PostgreSQL pool and approved token-digest adapter are supplied. Live database provisioning, API runtime wiring, and real-PostgreSQL integration acceptance remain pending.
- [ ] Authentication, password/passkey flows, MFA, and session revocation.
- [x] PostgreSQL selected as the initial relational database direction; versioned IAM migration and advisory-locked transactional migration runner added. Managed database provisioning and deployment remain pending.
- [ ] Audit event persistence and protected access.
- [ ] Production API authentication and authorization integration across all customer, merchant, shopper, courier, admin and owner data routes.
- [x] API authorization reference route: server-side actor resolver seam, deny-by-default behavior, and merchant/branch isolation tests.
- [x] Persisted-session actor resolution contract: bearer parsing, digest comparison, active identity/session checks, scoped role validation, multiple active roles with independently scoped grants, and injected role-to-grant mapping (concrete crypto and persistence adapters not yet implemented).
- [x] Centralized API authentication/authorization guard shared by protected routes; authentication and scope authorization run before repository availability checks or business-data access. Tests cover unauthenticated requests, scope denial without repository calls, and authorized branch reads (production repository adapter not yet implemented).
- [ ] Durable scheduled task queue adapter, transactional outbox persistence, and worker execution.
- [ ] Production transaction adapter and payment-to-order reconciliation/compensation workflow.
- [ ] Payment provider capture/void/refund integration.
- [ ] Merchant inventory reservation API and reservation expiry/reconciliation.
- [ ] Live slot capacity aggregation across branches, shoppers and couriers.

## Not yet implemented
The customer, merchant, shopper, courier, admin, owner, payment, inventory, dispatch, AI operations, Telegram, and external integration applications are not yet operational. Customer delivery photo uploads, media storage, customer UI, API persistence and courier/pickup integration are not yet operational. Scheduled order booking UI, live slot capacity, payment execution, immediate merchant stock reservations, durable task queue workers, customer alternative selection and rescheduling are not yet operational.

## Acceptance rule
A checkbox is marked complete only when code is present and automated checks or documented acceptance evidence verify it. A design document or interface alone is not proof of an operational feature.


## PostgreSQL persistence progress (development branch)
- [x] Initial identities, role_assignments, and sessions schema migration with foreign keys, uniqueness constraints, and expiry indexes.
- [x] PostgreSQL IAM repository adapter implementing identity/session reads and transactional writes, session rotation and family revocation.
- [x] API composition root that wires persisted session and identity readers into bearer actor resolution when supplied a configured pool and digest implementation.
- [x] Versioned migration runner with PostgreSQL advisory lock, per-migration transaction, duplicate detection, and rollback on failure.
- [x] Automated migration-runner tests for ordering, repeatability, malformed versions, lock release, and rollback.
- [ ] Provision a real PostgreSQL instance and run the migration against it.
- [x] Add CI integration checks against a real ephemeral PostgreSQL 16 service for migration execution, identity/role/session persistence, principal isolation, and foreign-key enforcement. Full adapter concurrency tests and runtime server wiring to managed database configuration remain pending.
- [ ] Configure encrypted backups, retention, monitoring, and perform a restore drill.
