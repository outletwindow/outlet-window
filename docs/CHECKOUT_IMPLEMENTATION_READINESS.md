# Checkout implementation readiness

Status: **not ready for a production checkout endpoint**

This note records the verified repository state on branch `work/outlet-window-build` at commit
`132fb1389fcafd96481e7fe1713ae5c7e8056855`. It is an implementation gate, not a claim that
checkout is complete.

## Verified building blocks

- `PostgresCustomerCartStore` persists customer-owned carts and validates that variants are
  published, belong to an active merchant/branch, have a usable price, and have sufficiently
  fresh branch inventory. Cart prices are explicitly display snapshots, not checkout prices.
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
  outcome when provider creation may have succeeded but persistence is uncertain.
- `PostgresOrderTransitionStore` persists merchant suborder transitions and derived parent
  status with an audit event in one transaction.

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
5. **The pending-validation to awaiting-payment transition is not implemented as a trusted
   checkout operation.** Merchant transitions explicitly reject this transition. A new
   customer/platform-owned repository operation must lock the parent and all suborders,
   revalidate the order snapshot, and atomically move every row to `awaiting_payment`
   while recording a matching audit event.
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
5. Add a platform-owned order-readiness transition that locks the parent and every
   suborder, verifies every snapshot and required field, and moves all rows from
   `pending_validation` to `awaiting_payment` in one transaction with an audit record.
6. Only then allow the existing payment-intent service to dispatch. Keep capture webhook
   verification, inventory reservation, fulfillment outbox creation, and recovery handling
   as separate idempotent stages with explicit reconciliation.
7. Add PostgreSQL integration tests for concurrent cart mutation, price changes, inventory
   races, multi-tenant merchants, quote expiry, duplicate idempotency keys, partial failures,
   provider timeouts, and retry/reconciliation behavior before exposing the route.

## Release gate

Do not expose a production checkout endpoint until steps 1–7 have implementation, database
constraints, integration tests, and passing CI. A route that simply copies cart display prices
into `PostgresOrderStore` would be unsafe and is intentionally not an acceptable shortcut.
