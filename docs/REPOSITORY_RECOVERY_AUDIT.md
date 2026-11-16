# Repository recovery audit

Date: 2026-11-16
Scope: tracked Git tree on `fix/checkout-safe-line-total-arithmetic`

## Findings

The current branch contains 61 tracked files. It contains API entry modules and documentation, but does not currently contain a root package manifest, TypeScript configuration, test-runner configuration, or lockfile. As a result, a reproducible install/build/test command cannot be established from the checked-in tree.

The following relative imports in tracked TypeScript files do not resolve to tracked source files in the current tree:

### `apps/api/src/app.ts`
- `packages/domain/src/order-editing.ts`
- `packages/domain/src/postgres-customer-order-delivery-updater.ts`
- `packages/domain/src/audit.ts`
- `packages/domain/src/authorization.ts`
- `packages/domain/src/order-lifecycle.ts`
- `packages/domain/src/integration-hub.ts`
- `packages/domain/src/payment-adjustment-provider.ts`
- `packages/domain/src/actor-resolution.ts`

### `apps/api/src/postgres-app.ts`
- `packages/domain/src/authorization.ts`
- `packages/domain/src/identity.ts`
- `packages/domain/src/postgres-iam-store.ts`
- `packages/domain/src/postgres-merchant-branch-reader.ts`
- `packages/domain/src/postgres-merchant-branch-writer.ts`
- `packages/domain/src/postgres-audit-event-store.ts`
- `packages/domain/src/postgres-order-transition-store.ts`
- `packages/domain/src/postgres-payment-adjustment-store.ts`
- `packages/domain/src/integration-hub.ts`
- `packages/domain/src/postgres-payment-webhook-inbox.ts`

### Existing domain adapters
- `packages/domain/src/postgres-integration-registry-store.ts` imports missing `postgres-iam-store.ts` and `integration-hub.ts`.
- `packages/domain/src/postgres-platform-checkout-readiness-store.ts` imports missing `audit.ts`, `postgres-audit-event-store.ts`, and `postgres-iam-store.ts`.

## Important distinction

The API source references a `PostgresPaymentWebhookInbox` adapter, but that adapter is not present in the tracked tree. The API route verifies an HMAC signature and records an event receipt through an injected interface; this is not evidence that webhook processing, payment capture, refund execution, or ledger posting is operational.

## Recovery sequence

1. Restore the missing domain source modules and their tests from the authoritative working copy or a known-good Git revision.
2. Restore the package manifest, TypeScript configuration, test configuration, and lockfile from that same revision.
3. Install dependencies with the package manager selected by the restored lockfile.
4. Run typecheck, unit tests, API tests, and migration tests; record exact commands and results.
5. Implement and test the PostgreSQL webhook inbox, including provider/event uniqueness, payload-collision detection, transaction boundaries, retention, and worker processing.
6. Only then connect provider events to payment state transitions and immutable ledger entries.

## Verification status

- Git tree and tracked paths inspected.
- Relative import targets checked against the complete current branch tree.
- Build and tests: not run; the required project manifests and dependencies are absent.
- No claim of production readiness is made.
