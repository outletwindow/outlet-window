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

Implemented and CI-accepted on development commit `0c037ce401b57a3e697f7843cbd93c436dee3606`: PostgreSQL migration `0006_scheduled_task_outbox.sql` creates the durable outbox, payment-capture confirmation record, and idempotent internal task inbox. `PostgresScheduledTaskOutboxStore` implements unique-key enqueue, `FOR UPDATE SKIP LOCKED` claims, lease expiry recovery, compare-and-swap acknowledgement/retry/dead-letter updates, and tenant-scoped reads. `PostgresScheduledOrderTransactionRunner` commits the payment-capture confirmation and initial outbox tasks in one database transaction. The scheduled worker process (`pnpm worker:scheduled`) delivers due outbox envelopes into the durable inbox with the same idempotency key.

Important boundary: the worker currently guarantees durable, idempotent handoff into the inbox. It does not itself reserve merchant inventory, prepare goods, allocate couriers, collect products, charge, or refund. Those task consumers, alert delivery, operator review UI, authorized remediation, and production deployment/managed database provisioning remain unimplemented. The order remains `awaiting_payment` until the inventory reservation consumer records its outcome; payment capture is recorded separately.

## Atomic order confirmation boundary
The domain package also exposes an application port for committing an already-paid scheduled order and its initial outbox tasks:
- Validate order/tenant/payment reference, payment-capture timestamp, confirmation timestamp, and fulfillment version before opening a transaction.
- Reject empty task sets, tasks belonging to another order, and duplicate idempotency keys.
- Persist the confirmed order and enqueue every task through the same transaction callback.
- Treat an existing idempotency key as a safe replay, not as a second task.
- Propagate adapter errors so the transaction runner can roll back the complete unit of work.

Payment capture is deliberately outside this transaction boundary: the approved payment adapter must confirm the provider's actual capture result first. A production checkout saga still needs durable handling for the interval between provider capture and database commit, including provider idempotency, reconciliation, and compensation/refund policy. The domain port does not claim to solve that external distributed transaction.

Implemented contract and unit tests: `packages/domain/src/scheduled-order-commit.ts` and `scheduled-order-commit.test.ts`.

Not implemented: database transaction adapter, persistence schema, payment adapter, reconciliation worker, and production API route.

## Scheduled-order reconciliation
A read-only reconciliation contract compares the expected task envelopes for an order with persisted outbox records:
- Missing expected task: critical issue.
- Duplicate idempotency key: high-severity issue.
- Unexpected record for the order: high-severity issue.
- Dead-letter task: critical issue.
- Expired or malformed worker lease: high-severity issue.
- Pending task older than the configured threshold: warning.
- Cross-order records are rejected rather than silently mixed.

The reader port requires tenant and order scope. A production adapter must enforce tenant/merchant/branch authorization in the query itself, not rely on caller-supplied filters alone. Reconciliation is read-only: it reports issues and must not automatically charge, refund, reserve inventory, or replay tasks. Remediation requires a separately authorized workflow with audit records.

Implemented contract and unit tests: `packages/domain/src/scheduled-task-reconciliation.ts` and `scheduled-task-reconciliation.test.ts`.

Not implemented: persisted task reader, scheduled reconciliation worker, alert delivery, operator review UI, or automated remediation.


## Inventory reservation ordering
Provider-confirmed payment evidence is now persistable before inventory allocation. The branch inventory adapter requires this evidence and reserves the exact persisted merchant suborder lines atomically. The application checkout orchestrator must call these stages in order: persist verified payment capture evidence, reserve branch inventory, then enqueue timed preparation/dispatch tasks. The current repository adapters provide these boundaries but are not yet composed into a live checkout API route.


## Merchant-targeted task envelopes
Timed tasks may carry a merchant target (`merchantTenantId`, `suborderId`, `merchantId`, `branchId`). Idempotency keys are scoped to the suborder, allowing a multi-merchant parent order to create independent preparation/dispatch work without key collisions. Before publishing a targeted envelope into the durable inbox, the PostgreSQL publisher verifies that the suborder belongs to the parent order and matches the exact merchant tenant and branch. The inbox row remains scoped to the platform parent order; merchant ownership is carried in the validated payload for the eventual consumer.


## Durable inbox consumer processing
Migration `0008_scheduled_task_inbox_leases` adds `available_at`, lease token and expiry fields. A PostgreSQL inbox store claims due rows with `FOR UPDATE SKIP LOCKED`, recovers expired processing leases, and uses lease-token compare-and-swap for completion, retry and dead-letter. The generic worker validates targeted envelopes and dispatches to injected idempotent handlers. Real merchant preparation, shopper collection and courier dispatch provider handlers remain to be supplied and configured; the generic worker alone does not perform those external actions.
