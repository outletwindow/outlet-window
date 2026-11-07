# Scheduled Task Outbox

## Purpose
Define the durable handoff between order transactions and background workers for scheduled fulfillment. The domain package contains contracts and pure validation helpers only; it does not provide a database, queue broker, worker process, or live integration.

## Required persistence guarantees
- Store the order state change and its outbox rows in one database transaction.
- Enforce a unique constraint on `idempotency_key`.
- Enqueue must be insert-or-return-existing; retrying the same request must not create duplicate work.
- Claim due rows atomically. A worker claim must set a unique lease token and lease expiry so concurrent workers cannot process the same row at once.
- Every completion, retry, or dead-letter update must compare the current lease token. A stale worker must not overwrite a newer worker's claim.
- Recover expired leases after worker crashes.
- Persist attempt count, next available time, last error code, and publication time.
- Publish downstream work with the same stable idempotency key. Delivery is at-least-once; consumers must be idempotent.

## Lifecycle
1. The checkout/application transaction records the confirmed order state and outbox rows.
2. A worker atomically claims due rows and receives a lease.
3. The worker validates the lease and publishes the task to the appropriate internal consumer.
4. On confirmed publication, mark the row published using the lease token.
5. On transient failure, increment attempts and set a bounded exponential retry time.
6. On permanent failure or exhausted retry policy, move the row to dead letter and raise an operational alert.
7. Reconciliation checks orders whose expected tasks are missing, stuck, or inconsistent.

## Task ordering and dependencies
- Payment capture confirmation precedes the immediate merchant inventory reservation request.
- Preparation and collection tasks are not released before their calculated due times.
- Courier dispatch is scheduled from the delivery estimate and must not be released before its planned time.
- A task must not be marked complete solely because it was published; the owning domain consumer must persist its actual outcome.
- Alternative selection, refund, and rescheduling are separate explicit state transitions and must create their own auditable work.

## Security and operations
- Never place payment credentials, OTPs, passwords, or private customer data in task metadata or error messages.
- Restrict worker permissions by task type and tenant/merchant/branch scope.
- Record correlation ID, order ID, task ID, idempotency key, attempt number, lease owner, and outcome in protected logs.
- Monitor oldest pending age, expired leases, retry rate, dead-letter count, publish latency, and duplicate suppression.
- Provide controlled replay from dead letter with operator identity, reason, and audit event.
- Do not replay payment or refund actions without provider-level idempotency and reconciliation.

## Adapter acceptance tests
A production adapter is not accepted until tests prove:
- concurrent claims never return the same active lease;
- duplicate enqueue returns the existing logical task;
- expired leases can be reclaimed;
- stale lease tokens cannot complete or retry a task;
- a crash after publish but before acknowledgement does not create duplicate business effects;
- retry delay is bounded and dead-letter transitions are auditable;
- tenant and branch isolation is enforced on reads and writes;
- transactional order-plus-outbox commit and rollback behave correctly.

## Current status
Implemented in the domain package: outbox record contract, store port, creation validation, bounded retry-time calculation, lease validation, and unit tests.

Not implemented: database schema/migrations, unique constraints, transactional adapter, queue broker, worker runtime, dead-letter operations UI, monitoring, and production reconciliation. Database and infrastructure vendor choices remain pending owner approval.
