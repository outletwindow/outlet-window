# Checkout implementation readiness

Status: **not ready for a production checkout endpoint**

This note records the verified repository state on branch `work/outlet-window-build`. It is an implementation gate, not a claim that checkout is complete.

## Verified building blocks

- `PostgresCustomerCartStore` persists customer-owned carts and validates that variants are
  published, belong to an active merchant/branch, have a usable price, and have sufficiently
  fresh branch inventory. When increasing an existing line, it rechecks the exact external
  variant/SKU and aggregate requested quantity against fresh, confidence-qualified stock while
  holding the inventory row lock. Cart prices remain display snapshots, not checkout prices.
- `PostgresOrderStore` creates a parent order and merchant suborders/items transactionally,
  validates item arithmetic and currency, and protects retries with a customer-scoped
  idempotency key.
- `PostgresDeliveryQuoteService` supports service-area/pricing-rule quotes and an optional
  road-routing path. Its straight-line quote is explicitly an estimate, not a dispatch ETA.
- `PostgresBranchInventoryReservationAdapter` reserves exact catalog variants against
  branch stock only after verified full-order payment capture evidence exists. It does not
  claim an external POS/ERP hard reservation unless the integration guarantees one.
- `PostgresCustomerPaymentIntentCheckout` creates a payment intent only for an existing
  `awaiting_payment` order, using durable attempt/idempotency records and an unresolved
  outcome when provider creation may have succeeded but persistence is uncertain. The
  attempt store shares the injected checkout clock when validating provider expiry bounds,
  keeping deterministic expiry checks aligned across the checkout boundary.
- `PostgresOrderTransitionStore` persists merchant suborder transitions and derived parent
  status with an audit event in one transaction.

## Latest verification

- Push workflow #1676 (run `43612901214`) passed on branch head `e2a0d247b78c0b5c44dc58252bfab49ef42b3e91`.
- The workflow completed successfully, including the API typecheck, lint, tests, build, and PostgreSQL migration/constraint verification steps.
- The deterministic order-transition timestamp change now persists `context.occurredAt` as the transition update time, and its unit test asserts the SQL update parameter.
- The first CI attempt for that test exposed a TypeScript `exactOptionalPropertyTypes` issue in the test double. The test now omits the optional `values` property when undefined; the follow-up push workflow passed.
- Pull-request workflow #1677 (run `43612905777`) was still running at the time of this update.
- Passing CI verifies the branch code at this commit; it does not close the checkout orchestration gaps below. The cart remains separate from order creation and payment execution.

## Blocking gaps before a real cart-to-order checkout

1. **No cart-to-order orchestration or API route is currently composed.** The customer API
   exposes cart read/add/remove and payment-intent creation for an existing order. The
   PostgreSQL composition root wires the cart and payment-intent services, but does not wire
   a checkout application service that turns the authenticated customer's cart into an
   order.
2. **Checkout must reprice from trusted catalog rows while locking them.** It must not use
   `CustomerCartItem.priceMinor` as an authoritative amount. The current cart projection is
   useful for display and stale-stock warnings only.
3. **A complete delivery destination and quote contract is missing at order creation.**
   The existing delivery-destination API updates a paid order and requires an injected
   `CustomerDeliveryDestinationService`; the PostgreSQL composition root does not create
   a default address-book/destination service. Checkout must define the required destination
   fields, service area, selected branch, quote snapshot, and quote expiry before persisting
   an order.
4. **The order schema has no first-class item-price/quote snapshot contract.** The current
   order store persists item unit prices and totals, but a checkout application service must
   also persist enough immutable provenance to explain the source price, catalog variant,
   currency, pricing rule/version, tax/discount components, and delivery quote used.
5. **The atomic readiness transition now exists at domain/repository level, but is not
   wired to a checkout application service or API route.** `PostgresPlatformCheckoutReadinessStore`
   locks the platform parent and every merchant suborder, checks the delivery snapshot and
   expiry, verifies each suborder's persisted item totals, and atomically advances all rows
   to `awaiting_payment` with per-suborder audit events. It is not a substitute for cart
   repricing, inventory locking, or immutable price provenance, and must not be called until
   those upstream steps have committed their trusted order snapshot.
6. **Payment capture and inventory reservation are deliberately separate.** The existing
   reservation adapter requires verified capture evidence. Do not reserve stock based only
   on a client callback, a payment intent being created, or an unverified webhook.
7. **Failure handling must preserve payment uncertainty.** Once a provider may have charged
   the customer, failures must create a durable recovery case and must not trigger blind
   retries, silent partial order completion, or automatic release/refund without a
   compensating workflow.

## Multi-tenant invariants to preserve

- A parent `customer_orders` row belongs to the platform tenant.
- Each `merchant_suborders` row belongs to its merchant tenant. Migration
  `0005_marketplace_order_tenancy.sql` intentionally changed the suborder-to-parent
  relationship to reference the globally unique parent order ID, while separately
  enforcing merchant-tenant ownership.
- A multi-store cart can therefore contain merchants from different tenants. Do not force
  all suborders to share the platform tenant or the first merchant's tenant.
- Customer identity, merchant/branch ownership, catalog variant identity, and external
  inventory variant identity must each be resolved from trusted database relationships,
  never accepted as tenant claims from the request body.

## Required implementation sequence

1. Define a checkout request contract containing only customer-selected choices
   (destination, delivery service, and an idempotency key); derive customer identity from
   authentication and all merchant/catalog identities from persisted cart rows.
2. Add a transaction-safe cart snapshot/repricing service. Lock the cart/version and the
   exact catalog, merchant, branch, and inventory rows; reject stale or unavailable lines;
   calculate all line totals, taxes, discounts, fees, and delivery from approved server-side
   rules using integer minor units.
3. Obtain a server-side road-aware delivery quote where required, bind its selected branch
   and validity to the persisted snapshot, and reject expired or mismatched quotes.
4. Create the parent order, merchant suborders, immutable item/price/delivery snapshots,
   and checkout idempotency record atomically.
5. Use `PostgresPlatformCheckoutReadinessStore` only after the cart-to-order transaction
   has persisted authoritative item prices, immutable price provenance, and a valid delivery
   destination/quote snapshot. The operation locks the parent and every suborder, verifies
   item totals and quote validity, and advances all rows to `awaiting_payment` atomically
   with per-suborder audit records.
6. Wire the readiness operation into the authenticated checkout application service and
   API route only after steps 1–5 are complete. Only then allow the existing payment-intent service to dispatch. Keep capture webhook
   verification, inventory reservation, fulfillment outbox creation, and recovery handling
   as separate idempotent stages with explicit reconciliation.
7. Add PostgreSQL integration tests for concurrent cart mutation, price changes, inventory
   races, multi-tenant merchants, quote expiry, duplicate idempotency keys, partial failures,
   provider timeouts, and retry/reconciliation behavior before exposing the route.

## Release gate

Do not expose a production checkout endpoint until steps 1–7 have implementation, database
constraints, integration tests, and passing CI. A route that simply copies cart display prices
into `PostgresOrderStore` would be unsafe and is intentionally not an acceptable shortcut.


## Latest verification — platform readiness repository

- Added `PostgresPlatformCheckoutReadinessStore` on the build branch. It only accepts the
  platform parent tenant, locks the parent and all merchant suborders in deterministic order,
  rejects stale parent versions and non-pending suborders, checks that the delivery destination
  and quote are present and unexpired, and compares each persisted suborder subtotal with the
  sum of its persisted item lines.
- The transition updates all merchant suborders and the parent in one transaction, then
  appends one scope-matched audit event per merchant suborder before commit. Any mismatch or
  write conflict rolls the transaction back.
- Added unit tests for successful multi-tenant transition, expired quote rejection, audit
  branch mismatch, and stale parent version.
- CI Push #1684 passed on commit
  `63dd16d18ae10ed41264cf6ec8a2c218f86ea57b`: PostgreSQL migrations/integration scripts,
  TypeScript typecheck, lint, test, and build all succeeded.
- This is a repository capability only. No cart-to-order orchestrator, HTTP endpoint, or
  production payment activation is included in this change. Checkout remains blocked from
  production release until authoritative cart repricing, inventory and cart concurrency
  controls, immutable pricing provenance, idempotent order creation, failure recovery, and
  end-to-end PostgreSQL integration tests are complete.


## Latest verification — pricing reconciliation gate

- The platform readiness transition now requires the locked parent order to include a
  structured `metadata.checkoutPricing` snapshot. Its currency, product subtotal, delivery
  quote ID/rule/version, fee/tax components, discount, and computed total must reconcile
  exactly with persisted order lines, the delivery quote, and `customer_orders.total_minor`.
- A missing or malformed pricing snapshot, mismatched quote provenance, or parent total
  mismatch returns `invalid_snapshot` and rolls back before any status update.
- Added a regression test proving a parent total that differs by one minor unit is rejected.
- CI Push #1692 passed on commit `3bca0fb2b6b9ad6574c23f5b4264d3dbce408627`:
  PostgreSQL migration/integration checks, typecheck, lint, tests, and build all succeeded.
- CI #1690 initially exposed a TypeScript narrowing error in the discount field; the value
  is now explicitly narrowed before arithmetic. The final #1692 run is green.
- This remains a guarded repository operation, not an exposed checkout route. The upstream
  cart repricing, inventory/cart locking, immutable price snapshot writer, idempotent order
  creation, and recovery orchestration are still required before release.


## Latest verification — authoritative catalog repricing

- Added `PostgresCustomerCartRepricingService` as a guarded domain preflight. It serializes
  with customer cart add/remove operations using the same advisory lock, checks the expected
  cart version, joins each line to its exact tenant-owned published catalog variant, merchant,
  branch, and branch inventory, and locks the catalog/stock rows while calculating totals.
- Cart display prices are not read. Unit prices are derived from
  `COALESCE(commerce_catalog_variants.price_minor, commerce_catalog_products.price_minor)`;
  stale/insufficient inventory, missing catalog/stock mappings, currency drift, and unsafe
  integer totals fail closed. Lines are grouped by exact merchant and branch.
- Important boundary: this preflight returns after its transaction commits, so its returned
  snapshot is not a durable authorization to create an order later. Final order creation must
  revalidate in its own transaction. The preflight is not exposed as a public checkout route.
- Hardened `PostgresOrderStore.create`: while holding `FOR SHARE` locks on the exact
  tenant-owned published variant and product, it now compares each supplied unit price and
  currency against the current catalog values before inserting the order line. This prevents
  callers from lowering or otherwise forging item prices.
- Added regression tests for live-catalog repricing, stale cart versions, missing inventory
  joins, stock ineligibility, currency drift, unsafe totals, and order-line price/currency
  mismatch.
- CI Push #1698 passed on commit
  `6928dc64d3e51b203c653d8bda948109f9f2823a`: PostgreSQL migrations/integration checks,
  TypeScript typecheck, lint, all tests, and build succeeded.
- Checkout is still not production-ready: this preflight is not yet composed atomically with
  delivery quoting, immutable order creation, cart conversion, platform readiness transition,
  and payment recovery. Multi-branch/multi-stop delivery pricing must also be defined and
  verified before enabling multi-store checkout.


## Latest verification — immutable checkout pricing

- Added migration `0038_immutable_checkout_pricing_snapshot`. A pricing snapshot supplied
  on the initial customer-order insert can no longer be added later, removed, or changed by
  updating the order metadata. Other operational metadata remains editable.
- Added a PostgreSQL integration test that proves unrelated metadata updates still work while
  snapshot mutation and deletion fail with a check-violation.
- Registered migration 0038 in the application migration runner and API database readiness
  gate, and added the integration test to CI.
- Exported the durable cart store and authoritative cart repricing service from the domain
  package public index.
- This protects a snapshot once an eventual checkout writer stores it. It does not itself
  create that writer or make cart-to-order checkout atomic. Checkout remains blocked until
  transactional quote/order creation, cart conversion, reservation after verified capture,
  and recovery orchestration are implemented and tested.


## Latest verification — order-creation stock revalidation

- Hardened `PostgresOrderStore.create` to resolve the catalog variant external inventory key
  and lock the exact merchant/branch/SKU stock row before inserting each order item.
- It rejects missing, stale, low-confidence, or insufficient stock inside the same transaction
  that creates the parent order, suborders, and item rows. This closes the gap where the
  separate cart repricing preflight had released its stock locks before order creation.
- The order-creation check does not reserve stock. `reserved_quantity` is still incremented
  only by the existing verified-payment-capture reservation workflow. Stock can change after
  order creation, so post-capture reservation and recovery remain mandatory.
- Added tests for the row lock, exact external variant/SKU mapping, freshness, available quantity,
  and rollback on stale/insufficient stock. The PostgreSQL order-store integration fixture now
  seeds and cleans up the corresponding fresh branch-inventory row.

## Transaction composition primitive

- Added `PostgresOrderStore.createInTransaction(input, client)`. It performs the same input
  validation, idempotency lock/replay check, catalog price verification, exact branch stock
  lock, and order inserts, but deliberately does not issue BEGIN/COMMIT/ROLLBACK or release
  the caller-owned PostgreSQL client.
- The existing `create(input)` remains the self-managed transaction wrapper. This is a
  prerequisite for a future cart-to-order orchestrator to atomically reprice, quote, persist
  order/pricing snapshots, and close the cart in one transaction; it does not itself implement
  that orchestration or make checkout production-ready.
- Added a unit test proving the transaction helper leaves commit/rollback and connection
  lifecycle to its caller.

## Transaction-scoped cart repricing

- Added `PostgresCustomerCartRepricingService.repriceInTransaction(input, client)`. It
  performs the same customer-cart advisory lock, expected-version check, live catalog
  repricing, and exact branch inventory row locks as the standalone preflight.
- Unlike `reprice()`, the transaction-scoped method does not begin, commit, roll back, or
  release the caller-owned client. Its row/advisory locks remain held until the caller
  finishes the outer transaction, allowing order creation to use the same authoritative
  snapshot without a time-of-check/time-of-use gap.
- Added tests for successful repricing and version-conflict results while asserting that
  the caller connection is neither committed/rolled back nor released by the service.
- This is a transaction composition primitive, not yet the end-to-end cart checkout flow;
  delivery quote orchestration, immutable snapshot construction, cart closure, and the
  platform readiness transition still need to be composed and integration-tested together.

## Transaction-scoped cart conversion primitive

- Added `PostgresCustomerCartStore.closeAsConvertedInTransaction`. It marks only the
  authenticated customer's exact active cart as converted, and only when the expected cart
  version still matches. The update is tenant-scoped and uses a conditional
  `UPDATE ... RETURNING`, so stale versions, already-converted carts, and ownership
  mismatches return a conflict without changing data.
- The method accepts a caller-owned PostgreSQL client, acquires the same customer-scoped
  transaction advisory lock used by cart add/remove/repricing, and never begins, commits,
  rolls back, or releases the connection. Checkout orchestration must call it on the same
  transaction/client used for cart repricing and order creation, after a matching order has been durably inserted;
  any conversion conflict must roll back the whole checkout transaction.
- Unit tests cover successful conversion, stale/ownership conflict behavior, and validation
  before SQL. This is a composition primitive only: there is still no public cart-to-order
  checkout route, and multi-branch carts remain blocked until a multi-stop delivery quote
  and per-stop pricing contract are implemented and tested.


## Transaction-scoped delivery quote lookup

- Added `PostgresDeliveryQuoteService.quoteInTransaction(request, transaction)` so checkout
  orchestration can resolve the active service area, approved pricing rule, eligible branches,
  and expiring zone-center quote through its caller-owned PostgreSQL transaction queryable.
- The method does not begin, commit, roll back, or release the transaction. The caller must
  persist the exact quote provenance and order pricing snapshot before committing.
- This method deliberately preserves the existing zone-center distance estimate semantics;
  it must not be represented as a road ETA or used as a multi-stop route quote. Multi-branch
  carts remain unsupported for checkout until a verified multi-stop quote model is available.
- Added a unit test exercising the transaction-queryable path. The preceding cart-conversion
  change passed Push workflow #1713 on commit
  `1c93d819871a6b21ea59bbe565ce61e5a1c8cd29` (TypeScript, lint, tests, build, and
  PostgreSQL migration/integration checks).


## Transaction-scoped platform readiness transition

- Added `PostgresPlatformCheckoutReadinessStore.transitionToAwaitingPaymentInTransaction`.
  It performs the same parent/suborder locks, quote expiry and scope checks, persisted
  item/suborder total reconciliation, immutable pricing snapshot validation, state updates,
  and per-suborder audit writes as the standalone wrapper, but uses a caller-owned client.
- The transaction-scoped method never begins, commits, rolls back, or releases the connection.
  The caller must roll back the enclosing checkout transaction for every non-`ready` result
  and commit only after cart conversion and all other checkout writes succeed.
- The existing `transitionToAwaitingPayment` method remains as a self-managed wrapper and
  retains its commit/rollback/release behavior.
- Added a unit test proving the transaction-scoped readiness method leaves transaction
  lifecycle entirely to its caller. This is another composition primitive, not yet a complete
  cart-to-order orchestrator or a production checkout endpoint.
