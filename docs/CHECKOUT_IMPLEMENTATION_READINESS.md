# Checkout implementation readiness

Status: **not ready for a production checkout endpoint**

This note records the verified repository state on branch `work/outlet-window-build` at branch head commit
`2c77d0bda1d7003385b314055583b41c8516d44c`. It is an implementation gate, not a claim that
checkout is complete.

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
