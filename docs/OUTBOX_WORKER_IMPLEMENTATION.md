# Durable Scheduled Task Outbox - Implementation Contract

Status: implementation specification; not a production adapter.

This document is the handoff contract for the PostgreSQL outbox adapter and worker. It does not claim that a migration, worker, broker, or production consumer exists.

## Required record fields

Each row must contain:
- `id` (stable task identifier, primary key)
- `tenant_id`, `order_id`, and optional `suborder_id`
- `task_type` and versioned, validated `payload`
- `idempotency_key` (unique, non-empty)
- `status`: `pending`, `processing`, `published`, or `dead_letter`
- `available_at`, `attempt_count`, `max_attempts`
- `lease_token`, `lease_expires_at`, and `lease_owner`
- `created_at`, `updated_at`, `published_at`, and a sanitized `last_error_code`

Payment credentials, provider secrets, OTPs, passwords, session tokens, and unnecessary customer PII must never be stored in task payloads.

## Required database constraints and indexes

- Unique constraint on `idempotency_key`.
- Check constraints for supported status values, non-negative attempts, and valid lease state.
- Index for due pending rows ordered by `available_at, created_at`.
- Index for expired processing leases ordered by `lease_expires_at`.
- Tenant/order lookup index for reconciliation.
- Foreign keys only where the existing order schema and deletion/retention policy permit them.

## Transactional enqueue

The order state transition and its initial task rows must commit in one database transaction. Enqueue uses insert-or-return-existing semantics for the same idempotency key. A conflicting key with a different logical task must be reported as an integrity conflict, not silently treated as a successful duplicate.

## Atomic claim

Workers claim due tasks in a short transaction using row locking with `FOR UPDATE SKIP LOCKED`. Claiming sets a fresh cryptographically random lease token, owner, expiry, and increments the attempt count. The worker must not hold a database transaction open while calling a downstream service.

Expired leases become eligible for reclaim. A reclaimed task receives a new lease token; the prior worker is permanently stale.

## Acknowledge, retry, and dead-letter

Every state mutation is conditional on task ID, current status, and the current lease token:
- Success changes `processing` to `published` and records `published_at`.
- Transient failure changes the task back to `pending`, clears the lease, records a sanitized error code, and sets a bounded exponential retry time with jitter.
- Permanent failure or exhausted attempts changes the task to `dead_letter`, clears the lease, and emits an operational alert.
- A stale token updates zero rows and must be treated as a lost lease, never as success.

Downstream publication is at-least-once. Every consumer must enforce the stable idempotency key before applying business effects.

## Worker safety

- Validate task schema and tenant scope before dispatch.
- Dispatch only to an allowlisted task-type handler.
- Use provider-side idempotency for any external provider request.
- Never retry a charge, capture, void, or refund solely because an acknowledgement was lost; reconcile provider state first.
- Do not mark a business task complete merely because a message was published. The owning domain must persist its outcome.
- Keep logs free of raw payloads and secrets; log task ID, order ID, correlation ID, attempt, lease owner, and outcome.

## Required automated acceptance tests

1. Concurrent workers cannot claim the same active lease.
2. Duplicate enqueue returns the same logical task and does not create a second row.
3. Reusing an idempotency key for a different task is rejected.
4. Expired leases can be reclaimed with a new token.
5. A stale worker cannot acknowledge, retry, or dead-letter a reclaimed task.
6. A crash after publish but before acknowledgement causes no duplicate business effect at the consumer.
7. Retry delays are bounded and attempts eventually reach dead letter.
8. Tenant/order scope is enforced in every read and mutation.
9. Order update and outbox insertion roll back together.
10. Payment-related tasks require provider idempotency and reconciliation before replay.

## Delivery sequence

1. Confirm the repository's existing migration directory and migration runner.
2. Add the outbox migration and migration rollback/forward-compatibility tests.
3. Implement the PostgreSQL store against the existing domain port.
4. Add transaction-aware enqueue to the scheduled-order commit adapter.
5. Implement a worker runner with graceful shutdown and bounded concurrency.
6. Add a controlled dead-letter inspection/replay API with authorization and audit.
7. Add metrics and alerts for oldest pending age, expired leases, retry rate, dead-letter count, and publish latency.
8. Run the complete workspace typecheck, test, and build workflows before merging.

## Release gate

Do not mark this feature production-ready until all ten acceptance tests pass against PostgreSQL under concurrency, restart, and failure-injection scenarios. Payment and refund replay must remain disabled until provider-level idempotency and reconciliation are proven.
