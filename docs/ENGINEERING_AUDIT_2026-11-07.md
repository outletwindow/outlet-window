# Engineering Audit — 2026-11-07

## Scope and evidence

Reviewed the development branch `work/outlet-window-build`, API composition and route code, PostgreSQL adapters and migrations, authorization/session domain code, CI workflow, tests, and implementation status.

Latest verified CI run: [42409837951](https://github.com/outletwindow/outlet-window/actions/runs/42409837951). PostgreSQL migrations and SQL constraints, TypeScript typecheck, automated tests, and build all passed.

This is a source/repository audit. It is not a live production, penetration, provider integration, or deployed-environment test.

## Verified implemented foundations

- Fastify API with health/readiness endpoints and a versioned API foundation route.
- PostgreSQL IAM schema and persistence adapter for identities, scoped role assignments, sessions, token digest comparison, rotation, and family revocation.
- Production startup refuses to run without `DATABASE_URL`; readiness checks required migrations and graceful shutdown closes the API and pool.
- Deny-by-default authorization and server-side actor resolution from bearer sessions.
- PostgreSQL merchant/branch registry with tenant-scoped branch reads and merchant-scoped branch create/update operations.
- Branch creation rejects duplicates and inactive merchants; branch update is constrained by merchant and branch IDs.
- Domain contracts and tests for audit events, delivery instructions, scheduled fulfillment, order commit coordination, outbox behavior, and reconciliation.

## Findings and engineering gaps

1. **Dependency reproducibility — P1.** No `pnpm-lock.yaml` is present on this branch, while CI installs with `pnpm install --no-frozen-lockfile`. Dependency resolution is therefore not locked to a reviewed dependency graph. Generate and commit a lockfile, then use frozen installs in CI.
2. **CI security coverage — P1.** The workflow runs migration checks, typecheck, tests, and build, but does not currently run dependency vulnerability scanning, secret scanning, or a dedicated static security analysis step. These checks should be added before release.
3. **Authentication lifecycle — P0.** Password/passkey enrollment, MFA enrollment and recovery, secure credential lifecycle, and production session/token issuance are not implemented. The current code validates and resolves persisted sessions; it is not a complete customer sign-in system.
4. **API surface — P0/P1.** The current operational API is limited to health/readiness, foundation, access-check, branch summary, branch create, and branch update. Customer, catalog, inventory, cart, order, payment, shopper, courier, dispatch, admin, and owner APIs are not yet operational.
5. **Commerce and inventory — P1.** Product catalog, variants, branch stock synchronization/reservations, search, cart, multi-merchant checkout, pricing, and order persistence remain outstanding.
6. **Fulfillment — P1.** Shopper/courier onboarding, dispatch, routing, live location, capacity, pickup/handover proof, and delivery execution remain outstanding.
7. **Money movement — P0 before payments.** Payment provider integrations, signed webhook verification, ledger posting, refunds, settlement, payouts, and reconciliation adapters are outstanding. Do not process real payments until these controls are implemented and independently tested.
8. **Durable operations — P1.** Scheduled workflow domain contracts exist, but production outbox persistence, workers, retries, and monitoring remain outstanding. Audit events are not yet durably persisted and protected.
9. **AI and Telegram — P2.** Agent governance and task orchestration documents are not executable integrations; AI operations and Telegram command integration are not operational.
10. **Production infrastructure — release blocker.** No managed PostgreSQL, provider-managed backups, restore drill, production secrets, deployment, monitoring, or incident response acceptance has been demonstrated.

## Repository integration status

The comparison of `main` and `work/outlet-window-build` reports a diverged history: the development branch is 194 commits ahead and 4 commits behind `main`. The four commits unique to `main` were inspected. Their missing branch-summary authorization-before-read test and scheduled-task reconciliation documentation/status were restored into the development branch; the actor-resolution tests and expanded branch API tests were checked against the newer development versions. The branch remains four commits behind in Git history, so perform a final merge-base/conflict review before any merge. No merge was performed during this audit.

## Priority sequence

- P0: Complete production authentication/credential lifecycle; design and test payment controls before any real money movement.
- P1: Add a committed dependency lockfile and frozen CI installs; add dependency/secret/security scanning.
- P1: Complete persistent catalog, inventory, cart, order, and merchant workflows with tenant isolation and idempotency.
- P1: Implement durable outbox workers, scheduled task execution, and protected audit persistence.
- P2: Implement shopper/courier task lifecycle, dispatch, capacity, tracking, and custody proof.
- P2: Build customer, merchant, shopper, courier, admin, and owner interfaces; then connect AI/Telegram with scoped approvals.
- Release gate: provision production infrastructure, secrets, backups, restore drills, observability, security review, and end-to-end pilot acceptance.

## Safety and release boundary

- The default branch `main` was not modified.
- No pull request was merged.
- CI success verifies the automated checks listed above only; it does not certify the full Outlet Window product or production readiness.
- No live payment, inventory provider, maps, courier network, Telegram bot, or managed database was exercised.
