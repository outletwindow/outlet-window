# Outlet Window - Implementation Status

Last updated: 2026-11-09

## Engineering foundation
- [x] pnpm workspace and TypeScript configuration.
- [x] Fastify API foundation with health and readiness endpoints.
- [x] API foundation tests.
- [x] CI workflow for typecheck, tests, and build.
- [x] Domain package with deny-by-default authorization.
- [x] Authorization tests for tenant and branch isolation.

## Salla Merchant API connector progress
- [x] Added a Salla-specific catalog adapter using the documented Merchant API products endpoint `GET https://api.salla.dev/admin/v2/products`, page-based pagination, and the `products.read` scope.
- [x] Added tenant/integration-scoped access-token injection; the adapter never persists or embeds access tokens.
- [x] Normalizes product IDs, names, customer URLs, prices/currencies, images, SKU/variant identifiers, and stock signals when the API response includes them.
- [x] Added unit tests for product mapping, page pagination, tenant-scoped token lookup, invalid store host, invalid cursor, unavailable token, and malformed API response.
- [x] Added an OAuth token lifecycle manager with injected encrypted-vault storage, single-use refresh-token rotation, lock/re-read protection against parallel refreshes, and atomic persistence of replacement access/refresh tokens.
- [x] Added unit tests for valid-token reuse, expiry-window refresh, rotation persistence, malformed responses, and missing token state.
- [ ] Production must provide a distributed lock and encrypted secret-vault adapter; process-local locking or plain database token storage is not acceptable.
- [ ] Implement and test the Salla `app.store.authorize` webhook receiver to bootstrap token storage, including Salla signature verification and replay protection.
- [ ] Live OAuth installation, secure token refresh/rotation, Salla webhook signature verification and durable event intake, actual Salla sandbox account, and end-to-end sync remain pending.
- [ ] Salla product quantity endpoint supports branch filtering; implement and test a separate branch inventory sync before claiming branch-level live stock availability. Product-level quantity must not be treated as branch-specific stock.
- [ ] Merchant must authorize the `products.read` scope; no real credentials or store connection are configured.

## Merchant catalog adapter progress
- [x] Added a provider-neutral JSON-LD product-page adapter for Schema.org Product/ProductGroup data, offers, image URLs, explicit variants/sizes, source timestamps, and SHA-256 provenance.
- [x] Adapter validates HTTPS source and final redirect hosts against the provider allowlist, caps HTML response size, rejects unsupported cursor pagination, and never fabricates missing product fields.
- [x] Added unit tests for ProductGroup extraction, prices/currency, sizes, malformed structured data, off-domain redirects, oversized responses, and cursor rejection.
- [ ] The adapter is not a live Centrepoint connector yet: the merchant page fetcher must be supplied with DNS/IP SSRF protection, redirect revalidation, timeout, rate limiting, and response limits. Centrepoint's API portal requires login and API access approval; no API credentials or approved plan are configured.
- [ ] Category/product discovery, official API/feed contract, real product page verification, size-chart table extraction, scheduled refresh, and live PostgreSQL end-to-end sync remain pending.

## Implemented domain contracts (not yet connected to live services)
- [x] PostgreSQL commerce catalog repository: atomic page persistence for products and variants, tenant/provider checks, stale-snapshot protection, and rollback on partial failure. Verified by unit tests; live Centrepoint synchronization remains pending.
- [x] Added PostgreSQL migration `0018_commerce_catalog` for tenant/integration-bound normalized catalog products and variants, with external identity uniqueness, source provenance, HTTPS source checks, and tenant-scoped foreign keys. CI SQL acceptance covers insert, duplicate identity rejection, and cross-tenant variant rejection. A production catalog repository and live provider sync are still pending.
- [x] Bounded commerce catalog import orchestrator: validates HTTPS provider source, enforces tenant/provider ownership, validates full pages before persistence, rejects repeated cursors, and limits page/product counts. Persistence remains an injected interface; no live merchant adapter or database catalog store is claimed.
- [x] Provider-neutral universal commerce connector contracts: normalized catalog/product/variant envelopes, capability descriptors, exact-host HTTPS provider resolution, duplicate adapter protection, and product envelope validation tests. Centrepoint Saudi Arabia is the first planned provider profile; no live Centrepoint catalog adapter or synchronization is claimed yet. Other stores require supported APIs/feeds or provider-specific adapters.
- [x] Virtual try-on request contract for photo, video, and live-camera modes, explicit consent metadata, private media references, expiring sessions/results, and validation tests. Each try-on request now requires a source-attributed product size-chart reference.
- [x] Product size-chart domain contract for per-product/per-variant measurement tables, body-vs-garment distinction, source URL/reference, extraction provenance/confidence, content hash, and validation tests. The first merchant's site-specific extraction adapter, scheduled refresh, PostgreSQL persistence, admin review UI, and live fit guidance remain pending.
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
- [x] Durable scheduled task inbox lease store and generic at-least-once consumer worker: SKIP LOCKED claims, expired lease recovery, idempotency-key handler contract, bounded retry, dead-letter, and lease-CAS completion.
- [x] Concrete provider-dispatch handler boundary for merchant preparation, shopper collection, and courier dispatch; validates merchant/branch target, requires provider idempotency and durable acceptance reference, and classifies transient/permanent failures.
- [x] Separate PostgreSQL inbox fulfillment worker process with lease recovery, bounded retry/dead-letter, graceful shutdown, HTTPS-only bearer-authenticated provider adapter, redirect blocking, and required connector configuration checks.
- [x] Persist provider acceptance references atomically with inbox completion under the active lease; receipt validation and PostgreSQL migration/CI integration checks added. This is provider acknowledgement evidence, not yet a customer-facing live tracking timeline.
- [x] Five-second paid-order edit policy measured from provider-confirmed payment capture; rejects edits after fulfillment starts or task dispatch.
- [x] Delivery destination policy validates the agreed service-area radius, requires a fresh trusted server quote, and returns recalculated delivery fee/total/ETA and selected branch.
- [x] PostgreSQL delivery-destination updater locks order and payment evidence, rechecks the five-second window and dispatched-task state, then persists destination, quote, zone, branch, revised total, and append-only edit evidence atomically. PostgreSQL integration and SQL acceptance tests added.
- [ ] Customer-facing edit UI/API route, trusted geospatial service-area resolver, live pricing/ETA/branch quote provider, and payment-difference authorization/collection remain pending; the domain and persistence adapter are not yet exposed as a live customer feature.
- [ ] Configure and validate real merchant, shopper, and courier provider endpoints/tokens in each deployment environment; run provider sandbox contract tests and operational alert delivery.
- [ ] Scheduled-task reconciliation reader, recurring worker, alert delivery and authorized remediation workflow.
- [x] Self-healing policy engine with fail-closed classification, idempotent retry and explicitly expired-lease recovery rules, bounded attempts, cooldown, and human-review routing for security/data-integrity/unknown incidents.
- [x] PostgreSQL self-healing incident and recovery-event persistence migration, structured reason codes, durable attempt-count lookup, and migration-runner registration. Automated recovery executor wiring, incident producers across services, lease-claim concurrency hardening, operational alerts/dashboard, and end-to-end PostgreSQL acceptance tests remain pending.
- [ ] Production transaction adapter and payment-to-order reconciliation/compensation workflow.
- [ ] Payment provider capture/void/refund integration.
- [x] Branch-level inventory ledger, customer order item lines, merchant/branch-scoped reservation records, and PostgreSQL transaction adapter for atomic platform-side stock allocation; integration tests cover idempotency, exact order-line matching, and concurrent final-unit contention.
- [x] Idempotent reservation lifecycle operations for release, expiry, and consumption; release requires a reason, consumption requires verified handover proof, release/expiry restore allocation, and consumption decrements stock.
- [x] Durable provider-confirmed payment evidence can be recorded idempotently before branch inventory reservation. Payment capture itself remains external.
- [ ] Live slot capacity aggregation across branches, shoppers and couriers.

## Not yet implemented
The customer, merchant, shopper, courier, admin, owner, payment, inventory synchronization, dispatch, AI operations, Telegram, and external integration applications are not yet operational. The scheduled outbox-to-inbox worker and a separate configurable inbox fulfillment worker are implemented on the development branch. The latter requires all three HTTPS provider endpoints and credentials at startup; no real merchant, shopper, or courier provider has yet been configured or verified. A PostgreSQL branch inventory ledger and atomic platform-side reservation adapter exist, but checkout wiring and merchant POS/ERP hard-reservation acknowledgements remain pending. Customer delivery photo uploads, media storage, customer UI, API persistence and courier/pickup integration are not yet operational. Scheduled order booking UI, live slot capacity, payment execution, scheduled expiry processing, stock reconciliation, customer alternative selection and rescheduling are not yet operational.

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
- [x] Added migration `0020_inventory_reservation_line_scope` with a composite foreign key enforcing that every reservation line belongs to the exact merchant and branch on its reservation header; PostgreSQL CI rejects cross-branch line insertion.
- [x] Added migration `0021_unique_inventory_handover_evidence` with a tenant-scoped unique index preventing one consumed handover reference from being replayed against multiple reservations; PostgreSQL CI verifies duplicate evidence is rejected.
- [x] Added `verifyAndParseFulfillmentHandoverEvent`: verifies timestamped HMAC-SHA256 against the exact raw body before parsing, rejects stale/duplicate signature fields and non-completion events, validates tenant/merchant/branch/reservation identifiers, and namespaces provider handover references. Unit tests cover tampering, replay window, weak secrets, malformed payloads, and task-acceptance rejection.
- [x] Added `POST /api/v1/webhooks/fulfillment/:providerKey`, raw-body capture with a 65,536-byte limit, provider-specific secret resolution, signature verification, and a fail-closed authorization resolver that must bind the signed event to the exact tenant, merchant, and branch before persistence/stock consumption. Unauthorized scopes are rejected with 403 before the inbox is called.
- [x] Added durable PostgreSQL fulfillment handover inbox with provider-event deduplication and payload-digest collision detection. Event recording, exact tenant/merchant/branch reservation lookup, stock locking, quantity validation, reservation consumption, and event application are committed atomically.
- [x] Revalidates the exact connected carrier integration and branch grant inside the same transaction that consumes inventory, locking the integration, grant, merchant, and branch rows against concurrent revocation/deactivation. The transaction rejects missing or ambiguous connected provider identities.
- [x] PostgreSQL acceptance coverage now verifies that revoking a branch grant removes authorization and that duplicate connected integrations sharing one provider key are treated as ambiguous and rejected.
- [x] API route tests cover valid signed handover and rejection of unsigned events before persistence; PostgreSQL migration `0022_fulfillment_handover_event_inbox` and its CI acceptance check cover durable event identity constraints.
- [ ] Implement and configure the production authorization resolver against the approved carrier integration registry/merchant-branch assignment records; the API intentionally returns 503 until both secret and scope resolvers are supplied. Configure provider-specific webhook secrets in the production secret manager and complete real-provider sandbox/live webhook contract tests; no carrier integration is currently configured.
- [x] Added a PostgreSQL transaction adapter that locks branch stock rows, validates exact merchant suborder lines, reserves all lines or none, and safely returns unavailable variants when stock is missing/insufficient.
- [x] Added idempotency replay/conflict handling and integration tests for simultaneous requests competing for the final unit.
- [x] Added a tenant/merchant/branch-scoped PostgreSQL inventory read repository exposing available/reserved quantities, source, last-sync timestamp, and freshness confidence.
- [x] Added authenticated GET `/api/v1/merchants/:merchantId/branches/:branchId/inventory` with bounded result limits and branch-scope authorization; merchant employees receive read-only inventory access.
- [x] Added repository and API tests for tenant/branch predicates, bounded limits, read-only roles, and cross-branch denial; CI run 42610770365 passed typecheck, lint, tests, and build.
- [ ] Wire checkout to call this adapter after confirmed payment capture; no customer API route or merchant connector is claimed live.
- [x] Added a standalone PostgreSQL inventory reservation expiry worker with configurable polling/batch limits, branch-aware lifecycle calls, structured outcomes, and graceful shutdown.
- [x] Added Docker Compose service and package scripts for the inventory expiry worker; Compose configuration is validated in CI.
- [x] Added unit and PostgreSQL integration tests proving due reservations expire and reserved stock returns to availability; CI run 42610230116 passed typecheck, lint, tests, and build.
- [ ] Stock reconciliation against POS/ERP and merchant external hard-reservation acknowledgements remain pending.


## Reservation lifecycle progress (development branch)
- [x] Added idempotent release, expiry, and consume transitions protected by reservation-row locks and stock-row locks.
- [x] Release/expiry return reserved quantity to available stock; consume decrements both available and reserved quantities exactly once and records the handover reference.
- [x] Expiry cannot run before the configured expiry instant; terminal replays do not adjust stock twice.
- [x] Payment-provider capture evidence can be recorded before inventory reservation and replayed idempotently; no payment provider charge/capture call is performed by this adapter.
- [ ] Wire the checkout saga to call payment evidence persistence, then inventory reservation, then task enqueue in that exact order.

- [x] Reservation finalization schema enforces a release reason or verified handover reference for consumed stock; SQL acceptance tests cover invalid final states.
- [x] Reservation release/expiry API now requires merchant and branch path scope; authorization checks the exact branch assignment before calling the lifecycle adapter.
- [x] PostgreSQL reservation lifecycle locks and updates the reservation using tenant, merchant, branch, and reservation identifiers together; a reservation from another branch is indistinguishable from not found.
- [x] Reservation-line and stock-row reads are additionally filtered by the requested merchant and branch; finalization now requires the reservation status compare-and-swap to update exactly one row or the entire stock transaction rolls back. Tests cover scoped SQL predicates and a zero-row finalization conflict.
- [x] Owner/admin and branch-manager role mappings grant only branch-scoped reservation execution; ordinary merchant employees receive no reservation-finalization grant.
- [x] Route and PostgreSQL adapter tests cover cross-branch denial, trusted scope derivation, one-time release, and rejection of client-asserted handover proof.
- [x] Verified physical-handover event-to-reservation consumption is wired through the signed provider webhook and durable PostgreSQL inbox; provider task-acceptance receipts are not proof of physical pickup, and the public API cannot consume stock from client-supplied handover fields.
- [ ] Configure provider-specific secrets and validate actual carrier webhook delivery, retries, and operational alerting in a provider sandbox before enabling production traffic.


## Multi-merchant scheduled checkout progress (development branch)
- [x] Scheduled task envelopes can target an exact merchant tenant, suborder, merchant and branch; idempotency keys are scoped by suborder.
- [x] Orchestrator persists provider-confirmed payment evidence first, reserves each branch suborder, and only after every reservation succeeds commits all timed preparation/dispatch tasks together.
- [x] If any branch cannot reserve stock, no preparation/dispatch tasks are enqueued; any earlier successful reservation references are returned for explicit customer-choice/compensation handling.
- [x] Outbox worker validates target shape and inbox publisher verifies the target belongs to the exact order/suborder/merchant/branch before durable inbox insertion.
- [ ] Wire orchestrator to the authenticated checkout API and customer alternative/compensation workflow.


## Durable inbox consumer foundation (development branch)
- [x] Migration `0008_scheduled_task_inbox_leases` adds recoverable processing leases and due-time scheduling.
- [x] PostgreSQL inbox store atomically claims pending/expired rows with `FOR UPDATE SKIP LOCKED`, reclaims expired leases, and protects completion/retry/dead-letter with lease-token compare-and-swap.
- [x] Generic inbox worker validates task payload and merchant target, dispatches to injected idempotent handlers, retries transient errors with bounded backoff, and dead-letters permanent or unhandled tasks.
- [x] PostgreSQL integration tests cover concurrent claims, expired lease recovery, stale worker rejection, retry, dead-letter, and SQL lease constraints; CI run 42416928208 passed.
- [ ] Supply real merchant, shopper, and courier provider handlers and wire them into a separately configured inbox worker process. No external fulfillment integration is claimed live.


## Fulfillment dispatch worker (development branch)
- [x] Added a separate `worker:fulfillment` process that consumes durable inbox records using the PostgreSQL lease store; it is not mixed with the outbox publisher.
- [x] Added provider adapter contracts for merchant preparation, shopper collection, and courier dispatch. Each request includes tenant, suborder, merchant, branch and stable idempotency identity.
- [x] Provider adapter requires HTTPS and bearer credentials, blocks redirects, applies a bounded request timeout, and classifies retryable network/HTTP failures separately from permanent client rejections.
- [x] Worker refuses startup unless all three provider endpoints and tokens are configured, preventing unhandled tasks from being claimed and dead-lettered.
- [ ] Real provider endpoints, credentials, sandbox contract acceptance, monitoring/alert delivery, and production deployment remain external prerequisites. No real fulfillment action is claimed live.
- [ ] Provider contract currently expects POST JSON and a successful JSON response containing `status: "accepted"` plus a non-empty `providerReference`; align each connector with its provider's signed/verified contract before production use.

## Customer five-second order editing and delivery destination API
- [x] Five-second paid-order edit window is measured from provider-confirmed capture; the exact five-second boundary is exclusive and covered by a unit test.
- [x] Delivery destination persistence rechecks the edit window under row locks, blocks dispatched fulfillment, validates the trusted service-area snapshot and fresh server quote, then atomically updates destination, price, ETA, zone, branch and immutable audit event.
- [x] Added authenticated customer API route `PATCH /api/v1/customer/orders/:orderId/delivery-destination`; authorization is scoped to the order and the customer identity is derived from the verified session, not the request body.
- [x] Route accepts coordinates only; pricing, branch and service-area data are never accepted from the client.
- [x] PostgreSQL API composition can receive the trusted destination service through dependency injection.
- [ ] Implement and configure the production service-area resolver and quote/pricing provider, and wire it to `PostgresCustomerOrderDeliveryUpdater`; the API deliberately returns 503 until this trusted dependency is supplied.
- [ ] Connect the customer app UI, display the five-second countdown and repriced amount/ETA, and obtain explicit authorization/collection for any payment difference before confirming the change.

- [x] Map active customer IAM role assignments to `customer.order` read/update grants only when the assignment contains the exact `orderId`; assignments without an order scope receive no customer-order grant.
- [x] Add permission tests proving customers cannot receive a broad order grant and are limited to the assigned order.
- [ ] Ensure customer order IAM assignments are issued only after order ownership is verified by the order-creation/authentication workflow; do not create broad customer grants.

- [x] Fail closed on any delivery re-quote that changes the payable order total: the updater returns `payment_adjustment_required` and commits no destination/price changes until an authorized payment adjustment workflow exists.
- [x] Compare PostgreSQL bigint order totals without lossy JavaScript number conversion; added integration coverage proving a changed total leaves the order untouched.
- [ ] Implement provider-backed payment increase authorization/capture and decrease refund evidence, with explicit customer consent and idempotent reconciliation, before allowing changed totals.

- [x] Customer API explicitly returns HTTP 409 with `payment_adjustment_required` and a clear explanation when a destination quote changes the payable total; this avoids silently accepting a changed amount.
- [x] API test covers the payment-adjustment conflict response.


## Payment adjustment gateway and webhook safety (development branch)
- [x] Added a provider-neutral HTTPS payment adjustment adapter with bearer credentials supplied by deployment configuration, redirect blocking, bounded timeouts, idempotency keys, and strict accepted-response validation.
- [x] Added HMAC-SHA256 webhook signature verification over the exact raw request body, constant-time signature comparison, and a bounded timestamp tolerance.
- [x] Added migration `0014_payment_provider_webhook_inbox` with unique provider/event identity, payload digest, processing state, and terminal processing timestamp constraints.
- [x] Added migration `0016_payment_webhook_worker_envelope` with normalized event metadata, bounded attempts, due-time scheduling, and paired worker-lease constraints; PostgreSQL CI acceptance verifies valid/invalid leases and event status.
- [x] Added SQL acceptance coverage for duplicate webhook rejection and valid/invalid receipt states; CI now runs this test.
- [x] Added unit tests for HTTPS enforcement, idempotent request headers, malformed provider responses, tampered webhook bodies, and stale signatures.
- [ ] Select and configure the actual payment service provider and its sandbox credentials; no production payment provider is connected.
- [ ] Implement the authenticated customer flow that creates an adjustment intent directly from a trusted fresh delivery quote, then invokes the provider only after explicit consent.
- [x] Add a durable PostgreSQL payment webhook inbox foundation: persist only SHA-256 payload digests, deduplicate provider/event IDs, detect same-ID/different-payload collisions, claim receipts once, and finalize only claimed events; unit tests cover lifecycle and validation.
- [x] Add a raw-body Fastify webhook intake route that verifies the exact-body HMAC signature and timestamp before recording provider event IDs, and wire the durable PostgreSQL inbox into the production composition root.
- [ ] Supply a production secret-manager resolver for each enabled provider; the endpoint intentionally returns unavailable until one is configured.
- [x] Add a transactional webhook reconciliation operation that locks the processing receipt and payment adjustment, fences reconciliation by the active worker lease, conditionally updates the order total only after provider confirmation, appends immutable adjustment evidence, and finalizes the inbox receipt in the same PostgreSQL transaction; unit tests cover success, provider failure, stale order totals, duplicate state, and receipt/adjustment mismatch.
- [x] Add a leased payment webhook worker that claims due/expired-lease events with `SKIP LOCKED`, processes normalized success/failure/ignored envelopes, performs atomic reconciliation, applies bounded exponential retry, and dead-letters after 20 attempts.
- [x] Add a standalone worker process (`pnpm worker:payment-webhooks`) with database/migration checks, configurable polling/batch/lease limits, structured outcome logs, and graceful shutdown.
- [ ] Implement provider-specific event signature/field adapters and sandbox contract tests; the current API accepts a canonical normalized event envelope after HMAC verification, not a live PSP-specific payload contract.
- [ ] Add an operational retry/reconciliation worker and provider-specific contract tests before enabling live capture/refund.


## Multi-provider Integration Hub foundation
- [x] Added provider-neutral integration registry for payments, commerce, POS, ERP, carriers, and maps.
- [x] Added tenant-scoped registration metadata, explicit lifecycle status, capability declarations, and secret-manager references (no raw credentials stored in the registry).
- [x] Added event intake contract with tenant ownership checks, connected-state gating, UTC timestamp validation, and duplicate provider-event detection.
- [x] Added PostgreSQL migration `0015_multi_provider_integration_hub` with tenant-scoped foreign keys, unique provider event/idempotency keys, payload digest, and durable inbox state.
- [x] Added unit and SQL acceptance tests and included the SQL test in CI.
- [x] Implement PostgreSQL-backed `IntegrationRegistryStore` with tenant-scoped reads, insert-only registration, duplicate rejection, and durable event deduplication; PostgreSQL adapter unit tests added.
- [x] Add authenticated merchant-owner/admin API routes to list and register integrations, derive tenant identity from the authorized route scope, enforce family/capability validation, and default new registrations to `pending`; cross-tenant and duplicate-registration route tests added (CI run 42491951407 passed typecheck, tests, PostgreSQL acceptance checks, and build).
- [x] Add an authorized suspend endpoint with idempotent domain behavior and PostgreSQL compare-and-set status updates; disconnected integrations cannot be reactivated through suspension, and tenant-scoped route/domain/adapter tests pass (CI run 42492215365 passed typecheck, tests, PostgreSQL acceptance checks, and build).
- [x] Add authenticated merchant-owner/admin connection-verification API backed by an injected provider verifier; successful checks persist `connected`, failed checks persist `degraded`, and missing provider adapters return 503 without falsely marking a connection active. Domain and route tests cover these outcomes.
- [x] Add authorized suspension lifecycle with tenant-scoped compare-and-set persistence and idempotent behavior.
- [x] Add an authorized reconnect workflow for suspended/disconnected integrations; it returns the integration to `pending` and requires a fresh provider verification before event intake is accepted.
- [x] Add an admin-only secret-reference rotation API that accepts opaque `vault://` references only, validates the reference through an injected tenant-scoped secret-manager authorization contract, and persists only the reference (never raw credentials); domain, API, and PostgreSQL adapter tests added.
- [ ] Connect the reference validator to the selected production secret manager and perform provider credential rotation/revocation drills.
- [ ] Implement provider-specific adapters and sandbox contract tests for each selected POS, ERP, commerce, carrier, maps, and payment provider; the verification interface is injectable but no live provider adapter is configured.
- [ ] Add durable inbox worker with bounded retries, dead-letter handling, event normalization, and reconciliation.
- [ ] Add operational integration health dashboard, secret-manager deployment wiring, and per-provider rate limits.


## Automatic runtime operations (development branch)
- [x] Added a multi-stage Node 22 container image for the API and worker packages.
- [x] Added a Compose runtime with separate API, scheduled outbox, and payment webhook worker services.
- [x] Added restart-unless-stopped policies, init processes, bounded container logs, and graceful stop windows for long-running services.
- [x] Added API readiness healthcheck; the API readiness endpoint checks required database migrations.
- [x] Added a one-shot migration service; API and default workers wait for successful migration completion.
- [x] Added a fulfillment-worker profile that can only be enabled when the three real HTTPS connector endpoints and credentials are supplied.
- [x] Added Compose configuration validation to CI.
- [ ] Run the stack on a provisioned production host/container platform with persistent PostgreSQL, TLS, backups, and alerting.
- [ ] Configure provider-specific fulfillment endpoints and sandbox-test merchant, shopper, and courier integrations before enabling the fulfillment profile.
- [ ] Configure provider-specific payment webhook signature adapters and the production secret resolver before accepting real PSP events.
- [ ] Implement remaining recurring expiry/reconciliation, integration inbox, stock synchronization, notification/alert, and other planned workers before claiming the whole product is fully autonomous.


## Self-healing and automatic error recovery (development branch)
- [x] Added a fail-closed recovery policy controller with explicit incident classification.
- [x] Automatically permits only idempotent transient-job retries and recovery of leases explicitly confirmed expired.
- [x] Added cooldown checks, per-incident attempt caps, structured recovery records, and deterministic outcomes.
- [x] Security violations, data-loss risks, invariant violations, unknown failures, and non-idempotent operations require human review; the controller does not mutate them automatically.
- [x] Added unit tests for allowed recovery, approval boundaries, cooldown, attempt limits, and malformed incidents.
- [ ] Implement a durable PostgreSQL recovery incident store and worker that discovers incidents from API, queue, database, and integration health signals.
- [ ] Wire approved safe executors to real idempotent queue replay and lease-recovery adapters; no arbitrary shell execution or unrestricted database repair.
- [ ] Add alert delivery, recovery dashboard, incident correlation, and post-recovery verification against real services.


## Fulfillment handover inbox schema (development branch)
- [x] Added migration `0022_fulfillment_handover_event_inbox` with provider/event uniqueness, SHA-256 payload digest, tenant/merchant/branch/reservation identity, namespaced handover reference, UTC event time, and constrained receipt states.
- [x] Registered migration 0022 in the versioned migration runner and API readiness requirements.
- [x] Added PostgreSQL CI acceptance coverage for provider event deduplication and digest-based detection of same-ID/different-payload collisions.
- [ ] Implement the PostgreSQL inbox writer and atomic receipt-to-reservation consumer; the table is currently a durable schema foundation, not yet a live webhook endpoint.
- [ ] Add signed fulfillment webhook route, provider secret-manager wiring, route tests, and transaction-level acceptance tests before enabling external carrier events.


## Signed fulfillment handover endpoint and atomic consumer
- [x] Added `POST /api/v1/webhooks/fulfillment/:providerKey`; it captures the raw body, verifies the timestamped HMAC signature, and rejects malformed or untrusted events before persistence.
- [x] Wired a PostgreSQL adapter that records provider-event identity and payload digest, locks the exact tenant/merchant/branch reservation, validates expiry and stock ledger quantities, consumes reserved and available quantities, and marks the inbox receipt applied in the same transaction.
- [x] Duplicate event IDs with identical payloads return the existing receipt; same-ID/different-payload attempts return a collision.
- [x] Provider handover references are length-bounded after namespacing to fit the reservation ledger.
- [ ] Add focused API route tests and a PostgreSQL transaction-level acceptance test before enabling a real carrier provider.
- [ ] Supply provider secrets through the host secret manager via `fulfillmentWebhookSecretResolver`; no provider secret is embedded in source.

## Immediate checkout orchestration — verified gap and acceptance gate
- [x] Re-verified that PostgreSQL exact-variant reservation and reservation finalization are implemented as separate domain adapters; the API composition root currently wires the lifecycle adapter but does not wire the reservation adapter into an immediate-checkout application service.
- [x] Re-verified that the scheduled checkout orchestrator records provider-confirmed capture evidence, reserves each merchant suborder, and only then commits scheduled outbox tasks. Its documented contract does not charge, refund, or automatically compensate prior holds when a later suborder fails.
- [x] Re-verified that the generic payment webhook inbox/worker is not an initial-order payment confirmation flow: its reconciliation path is scoped to payment adjustments.
- [x] Re-verified that merchant suborder transitions enforce payment/inventory context for confirmation, preparation evidence before ready-for-pickup, and verified fulfillment evidence before reservation consumption.
- [x] Re-verified that the public reservation-finalization route rejects client-asserted handover proof; consumption is reserved for the signed fulfillment event path.
- [ ] Implement an application-level checkout coordinator for immediate and scheduled orders with a trusted, provider-confirmed payment result; do not accept client-supplied paymentCaptured/inventoryReserved booleans or provider references as proof.
- [ ] Persist a durable checkout/idempotency state machine that coordinates multi-merchant reservations, order/suborder status changes, and outbox creation; define explicit partial-reservation recovery states.
- [ ] Define and implement compensation policy for payment captured but one or more branch reservations unavailable: customer choice, provider refund/void where supported, and auditable retry/reconciliation. Never silently release stock and assume payment was refunded.
- [ ] Connect reservation release to authorized cancellation/merchant rejection only after the payment/refund decision is recorded; keep expiry worker and signed handover consumption as separate trusted paths.
- [ ] Add PostgreSQL integration acceptance tests for full immediate checkout, replayed requests/webhooks, concurrent checkout, second-merchant reservation failure, task-commit failure, cancellation, expiry, and verified handover; assert payment and stock ledgers remain consistent.
- [ ] Do not mark immediate checkout production-ready until the coordinator is wired through the API composition root, provider-specific payment contract tests pass, and all acceptance cases pass in CI.

- [x] Additional implementation detail confirmed during follow-up: `PostgresBranchInventoryReservationAdapter` currently gates new reservations on `scheduled_order_confirmations`; it therefore cannot serve a true immediate-payment path without a generalized, trusted payment-capture evidence contract. Existing idempotent replay is checked before that gate, but that does not make first-time immediate reservations supported.
- [x] Confirmed the merchant suborder transition API explicitly sets payment, inventory, delivery, and refund proof flags to false server-side; clients cannot assert these proofs in the transition request. Keep this fail-closed behavior.

## Verified initial-order payment capture ledger — schema foundation
- [x] Added migration `0027_verified_order_payment_captures` with tenant/order binding, provider event and payment-reference uniqueness, idempotency uniqueness, captured amount/currency/time, and immutable evidence rows.
- [x] Database insertion trigger locks the payable order and rejects captures unless the order is awaiting payment and the captured amount/currency exactly match the current order total/currency; future capture timestamps are rejected.
- [x] Registered migration 0027 in the explicit migration runner and API readiness gate.
- [x] PostgreSQL CI acceptance covers exact amount/currency acceptance, amount mismatch rejection, duplicate provider event/reference rejection, and immutable evidence mutation rejection.
- [x] Exact-variant inventory reservation now accepts a matching row from the new verified-capture ledger while retaining the legacy scheduled-confirmation path.
- [ ] Implement the trusted provider verification adapter/worker that verifies provider signatures and canonical payment status before inserting this ledger row. No public/customer route may write verified capture evidence.
- [ ] Add a writer-level PostgreSQL adapter with replay/collision semantics and tests for same event/same payload versus same event/different payload.
- [ ] Connect verified capture recording to immediate multi-store checkout orchestration, order/suborder state transitions, task outbox commit, and explicit partial-reservation reconciliation. No live PSP is selected or configured.

## Trusted initial payment-capture webhook processing — development foundation
- [x] Added a provider-specific capture decoder boundary: each configured provider must decode the exact signed raw body into an event ID, provider payment reference, positive amount, currency, and capture timestamp.
- [x] Added a capture processor that verifies the timestamped HMAC over the exact raw body, rejects invalid/future capture events, and resolves the order only from a server-owned provider payment-intent reference. Webhook-supplied tenant/order identifiers are ignored.
- [x] Added PostgreSQL persistence with server-generated capture IDs, unique provider event/reference and order idempotency identities, exact replay recognition, and identity-collision detection.
- [x] Routed signed `payment.captured` events to the dedicated capture processor; adjustment events continue through the existing adjustment inbox path.
- [x] Added unit tests for valid signature, invalid signature, server-owned order resolution, unknown intent, future timestamp, exact replay, identity collision, malformed evidence, and API routing.
- [ ] The server-owned payment-intent/order resolver and provider-specific decoders still need production implementations and sandbox contract tests. No real PSP adapter or payment intent creation flow is configured.
- [ ] Add an initial payment webhook inbox worker/retry lease flow and transactional reconciliation between receipt finalization and capture ledger insertion before enabling live traffic.
- [ ] Do not enable checkout reservation from this processor until the payment intent resolver is backed by a persisted server-created payment intent and provider contract verification has passed.


## Durable initial-order payment capture webhook inbox — schema foundation
- [x] Added migration `0029_initial_payment_capture_webhook_inbox` with provider/event deduplication, server-owned payment-intent binding, payload digest, canonical capture fields, bounded attempts, retry scheduling, and paired worker leases.
- [x] Raw webhook payloads and signatures are not persisted; event identity and capture evidence fields are immutable while processing state remains mutable.
- [x] Added PostgreSQL acceptance coverage for duplicate events, immutable event identity, lease constraints, claim/finalize lifecycle, and truncate protection.
- [x] Added a dedicated initial-capture inbox writer with raw-body digest deduplication, server-owned payment-intent binding, and same-event/different-payload collision detection.
- [x] Added a leased initial-capture worker that revalidates the persisted payment intent and payable order, inserts immutable capture evidence, and finalizes the inbox receipt in one PostgreSQL transaction.
- [x] Added bounded exponential retry/dead-letter handling and a standalone worker process/Compose service; the existing payment webhook worker remains adjustment-only.
- [x] Production composition root now constructs the capture processor with the PostgreSQL payment-intent resolver, immutable capture store, and durable inbox whenever a provider decoder registry and secret resolver are supplied.
- [ ] Supply the selected PSP's provider-specific decoder registry and secret-manager resolver in deployment configuration; no live PSP is enabled by default.
- [ ] Wire the signed capture route to this durable inbox after provider-specific decoder and secret-manager verification; no live PSP is enabled.

## Server-owned provider payment intent mapping — development foundation
- [x] Added migration `0028_provider_payment_intents` for provider reference to tenant/order mapping, exact amount/currency, expiry, tenant-scoped idempotency, and immutable records.
- [x] Database insertion requires an order in `awaiting_payment`, exact order total/currency, and an expiry within 24 hours.
- [x] Added `PostgresPaymentIntentStore` to persist provider references only when supplied by a trusted backend after provider intent creation, and to resolve webhook references from server-owned records.
- [x] Initial capture resolver now matches provider reference, amount, currency, unexpired intent, and payable order; webhook metadata never supplies tenant/order identity.
- [x] Added adapter unit tests and PostgreSQL migration acceptance checks to CI.
- [ ] The PSP API call that creates the external payment intent, provider-specific signature/decoder adapters, secure secret resolution, durable initial-capture inbox/worker, and production credentials remain pending.
- [ ] The intent store is a persistence boundary, not a live payment gateway. Do not treat the generic webhook route as production-ready until a provider contract and deployment wiring are verified.


## Moyasar webhook verification adapter — development increment (2026-11-10)
- [x] Added an isolated Moyasar webhook verifier that validates the documented JSON envelope fields `id`, `account_name`, and `secret_token` against the endpoint's configured shared secret using constant-time byte comparison.
- [x] Added fail-closed tests for valid envelopes, wrong secrets, missing fields, malformed JSON, oversized payloads, arrays, and null values.
- [x] Extended the initial payment-capture processor with an injectable provider-specific webhook-verifier registry while retaining the existing timestamped HMAC verifier as the fallback for already-supported generic providers.
- [ ] Wire `moyasarWebhookVerifier` into the deployment's provider registry and secret-manager resolver; no Moyasar credentials or live endpoint are configured.
- [ ] Implement and verify the Moyasar-specific payment-capture event decoder against the account's enabled webhook event schema and sandbox payloads; this verifier alone does not make Moyasar payments operational.
- [ ] Run Moyasar sandbox contract tests and confirm webhook registration, retry handling, event deduplication, and canonical payment-status reconciliation before enabling live traffic.


## Moyasar capture webhook decoder — development increment (2026-11-10)
- [x] Added a Moyasar-specific decoder that accepts only `payment_captured` events and requires the nested payment status to be `captured`.
- [x] Maps the provider event ID, payment ID, captured amount (including partial captures), currency, and captured timestamp into the canonical capture contract.
- [x] Rejects `payment_paid`, `payment_authorized`, refund, void, 3DS, malformed, invalid-timestamp, zero-capture, and malformed-currency events from the initial-capture path.
- [x] Tightened webhook envelope validation to require event ID/type, valid creation timestamp, live-mode boolean, object data, account name, and non-empty shared secret.
- [x] Exported the verifier and decoder from the domain package.
- [ ] Add provider registry wiring in the API composition root and map deployment secret-manager references to the Moyasar webhook secret.
- [ ] Add a trusted Moyasar payment-intent creation/fetch adapter and verify webhook payment IDs against server-created intents; do not treat the webhook body as sufficient proof of payment.
- [ ] Add end-to-end sandbox tests for purchase, authorization then capture, partial capture, duplicate delivery, refunds, voids, and test/live key separation.


## Moyasar API runtime wiring — development increment (2026-11-10)
- [x] API capture route now recognizes Moyasar's native `payment_captured` event name in addition to the existing provider-neutral `payment.captured` event.
- [x] Added API route coverage proving native Moyasar capture events are sent to the trusted capture processor and bypass the payment-adjustment inbox.
- [x] Added injectable provider-specific webhook verifiers to the PostgreSQL API composition root.
- [x] Registered the Moyasar capture decoder and shared-secret verifier in the API server composition root.
- [x] Added `MOYASAR_WEBHOOK_SECRET` to the environment example and passed it only to the API service through Compose; a blank value keeps the provider unavailable (fail-closed).
- [ ] Verify CI for the new provider route, decoder, verifier, TypeScript, full tests, database acceptance suite, and Compose validation.
- [ ] Provision the secret in the deployment secret manager and register the HTTPS webhook URL in Moyasar dashboard; no credential or live endpoint is present in this repository.
- [ ] Implement authenticated server-side payment creation and authoritative payment fetch/reconciliation before production activation.
