# Refund Financial Journal Design

Status: Design decision record — implementation pending
Scope: provider-confirmed customer refunds and their effect on the Outlet Window double-entry ledger.

## 1. Current verified behavior

- A verified capture is journaled as debit `PAYMENT_CLEARING` and credit `CUSTOMER_FUNDS_HELD`.
- An approved merchant settlement journal debits `CUSTOMER_FUNDS_HELD`, credits `MERCHANT_PAYABLE` for net proceeds, and credits configured deduction accounts for deductions.
- Settlement approval is an accounting reclassification only. It is not a payout and the current settlement schema has no provider/bank payout confirmation state.
- Refund reservations bind a refund adjustment to the exact verified capture and reserve refundable capacity.
- A provider-confirmed refund updates payment-adjustment/order state, but there is currently no refund journal projector.

## 2. Required invariant

A refund journal may be posted only after authoritative provider confirmation and only after the refund's amount has been allocated to the affected financial components. The journal must be tenant- and currency-scoped, balanced, immutable after posting, and idempotent by the refund adjustment/reservation identity.

A refund reservation alone is not accounting evidence. A queued, submitted, ambiguous, or quarantined refund must not create a posted refund journal.

## 3. Allocation is a prerequisite

The current refund adjustment is order-level, while merchant settlement lines are suborder-level and may include merchant gross, deductions, and net payable. A single order-level refund amount does not identify which merchant/suborder, delivery charge, tax, discount funder, or platform fee is being reversed.

Before the projector is implemented, persist an immutable refund allocation for each confirmed refund, with at least:
- tenant, adjustment, original capture, currency and amount;
- order and, where relevant, merchant/suborder/branch;
- component code and amount in minor units;
- source settlement line/batch, if one exists;
- the accounting treatment and account mapping selected for that component.

Allocation totals must equal the provider-confirmed refund amount exactly. Allocations must not exceed the remaining refundable amount of their source components. The allocation policy must be deterministic and auditable; do not infer merchant responsibility from the overall order total.

## 4. Current ledger treatment by settlement state

For allocated customer-refund value attributable to merchant proceeds:

### Before settlement approval
Debit `CUSTOMER_FUNDS_HELD`; credit `PAYMENT_CLEARING`.

This reverses the relevant held customer liability and the provider clearing receivable.

### After settlement approval, before any payout
Debit `MERCHANT_PAYABLE`; credit `PAYMENT_CLEARING`.

This reduces the merchant liability created by the approved settlement. The approved settlement journal and lines remain immutable; the refund is a separate journal linked to the original settlement line and refund allocation.

This treatment is valid for the current implementation because settlement approval explicitly does not pay out funds. It must not be used as proof that funds were recovered from a merchant.

### After a future payout has actually occurred
Do not debit `MERCHANT_PAYABLE` as if it were still outstanding. A separately designed merchant recovery/receivable workflow is required, with payout evidence, merchant liability/receivable policy, collection/offset rules, disputes, and reconciliation. No such payout or recovery workflow is currently implemented.

Non-merchant components (tax, delivery, platform fee, discounts/promotions) require their own source-component and account mappings. They must not be forced through the merchant-payable account.

## 5. Concurrency and ordering

The future implementation must serialize refund allocation and settlement approval for the same suborder/source balance. It must lock records in one documented global order, and must prevent:
- a refund being allocated against a source balance already fully settled/refunded;
- settlement approval racing with a refund allocation and consuming the same held balance;
- duplicate provider events or projector retries posting duplicate journals;
- an ambiguous provider outcome releasing reserved refundable capacity;
- an order-level refund from silently being assigned to an arbitrary merchant.

A settlement batch must not be amended after approval. Post-approval refunds are separate adjustment journals and immutable allocation records.

## 6. Required tests before production use

1. Provider pending/unknown/reconciliation-required refund creates no journal.
2. Provider-confirmed refund with complete allocations posts one balanced journal.
3. Replaying the same confirmation/projector call returns duplicate without a second journal.
4. Allocation total mismatch, missing source component, wrong tenant/currency/capture, or over-allocation fails closed.
5. Pre-settlement allocation debits held funds and credits clearing.
6. Post-approval/pre-payout allocation debits merchant payable and credits clearing, linked to the exact settlement line.
7. Concurrent settlement approval and refund allocation cannot consume the same source balance.
8. Multi-merchant order refunds require explicit per-suborder allocation.
9. Non-merchant components use separately configured and validated accounts.
10. A future paid-out settlement cannot use the pre-payout treatment and must enter the merchant-recovery workflow.

## 7. Implementation boundary

This document is a design record, not an implemented accounting feature. Do not create refund journals until immutable component allocations and their source-balance controls exist. Do not claim live payout, merchant recovery, or production payment custody.
