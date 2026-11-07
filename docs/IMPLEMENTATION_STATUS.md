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
- [ ] Scheduled task inbox consumers for merchant reservation/preparation, shopper collection, and courier dispatch; operational alert delivery and authorized remediation.
- [ ] Scheduled-task reconciliation reader, recurring worker, alert delivery and authorized remediation workflow.
- [ ] Production transaction adapter and payment-to-order reconciliation/compensation workflow.
- [ ] Payment provider capture/void/refund integration.
- [ ] Merchant inventory reservation API and reservation expiry/reconciliation.
- [ ] Live slot capacity aggregation across branches, shoppers and couriers.

## Not yet implemented
The customer, merchant, shopper, courier, admin, owner, payment, inventory, dispatch, AI operations, Telegram, and external integration applications are not yet operational. The scheduled outbox-to-inbox worker is implemented on the development branch but does not yet execute merchant reservation, preparation, shopper collection, or courier dispatch consumers. Customer delivery photo uploads, media storage, customer UI, API persistence and courier/pickup integration are not yet operational. Scheduled order booking UI, live slot capacity, payment execution, immediate merchant stock reservations, durable task queue workers, customer alternative selection and rescheduling are not yet operational.

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
