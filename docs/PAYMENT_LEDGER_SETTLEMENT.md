# Outlet Window — Payment, Ledger & Settlement Architecture

Version: 1.0
Status: Draft — Pending Technical and Legal Review

## 1. Purpose
Define payment processing, financial records, merchant settlements, courier and shopper earnings, refunds and reconciliation.

## 2. Ownership
- Payments owns payment transactions, authorization, capture and refunds.
- Financial Ledger owns immutable financial journal entries.
- Settlement Engine calculates amounts payable to merchants and workforce participants.
- Order Management owns order and suborder references.
- Audit records all sensitive financial actions.
- AI Financial Analyst provides analysis and recommendations only.

## 3. Payment Models
Support configurable models by country, merchant contract and payment provider:
- Customer pays through Outlet Window; merchant receives product proceeds and Outlet Window receives its fees.
- Outlet Window collects the full permitted amount and settles merchant proceeds under an approved legal and payment structure.
- Merchant checkout integration where Outlet Window provides an authorized delivery or fulfillment service.

Do not enable a model until legal, regulatory and payment-provider approval is confirmed.

## 3A. Scheduled Checkout Payment Sequence

For a scheduled order, payment is collected at checkout according to the disclosed payment method behavior. After provider-confirmed capture, Order Management requests an immediate exact-variant inventory reservation from the merchant branch. Preparation is scheduled for the calculated release time; it is not delayed until then to create the order or reserve stock.

If payment fails, the order is not confirmed and inventory reservation is not requested. If payment succeeds but stock cannot be reserved, keep the order in an explicit exception/customer-choice state and show eligible alternatives. If the customer declines or no alternative is available, create a refund linked to the original payment. Refund execution must be idempotent and provider-confirmed. Never silently substitute an item.

Some payment methods may use authorization followed by capture rather than immediate capture. The UI must accurately disclose whether funds are captured or only held. A payment status must always come from the payment provider, never from an order status change.

## 4. Payment Lifecycle
1. PAYMENT_INITIATED
2. PAYMENT_PENDING
3. PAYMENT_AUTHORIZED
4. PAYMENT_CAPTURED
5. PAYMENT_FAILED
6. PAYMENT_CANCELLED
7. REFUND_PENDING
8. REFUND_PARTIALLY_COMPLETED
9. REFUNDED
10. PAYMENT_DISPUTED

Provider confirmation is required for final payment and refund states.

## 5. Financial Ledger
- Use double-entry accounting.
- Every journal entry must balance.
- Record currency, amount, account, reference, timestamp and source.
- Posted entries must not be silently edited or deleted.
- Corrections use traceable reversal or adjustment entries.
- Separate actual money from promotional credits and loyalty points.
- Maintain records per legal entity and currency.

## 6. Merchant Settlement
Calculate:
- Product proceeds.
- Discounts and their funding party.
- Platform commissions and service fees.
- Delivery charges.
- Taxes.
- Refunds and adjustments.
- Net merchant payable.

Settlement schedules, reserves, minimum thresholds and payout methods are configurable per approved contract.

## 7. Courier and Shopper Earnings
- Calculate task compensation from approved pricing rules.
- Record bonuses, waiting time, distance and permitted adjustments separately.
- Show earnings and task evidence to the participant.
- Disputed adjustments require review.
- Payout eligibility and timing depend on applicable law and contracts.

## 8. Refunds and Reversals
- Link every refund to the original payment and order.
- Support full and partial refunds.
- Prevent duplicate refund execution through idempotency.
- Track provider processing status.
- Preserve customer statutory rights.
- AI cannot independently deny a legally valid refund.

## 9. Reconciliation
Compare internal records with payment-provider reports and bank settlement statements.
Detect missing, duplicate, delayed or mismatched transactions.
Create exceptions for authorized human review.
Never resolve a financial mismatch by silently changing historical records.

## 10. Security and Permissions
- Least-privilege access.
- Strong authentication for financial operations.
- Dual approval for configured high-risk actions.
- Encryption of sensitive data.
- No card details, passwords or payment secrets in logs or Telegram.
- Full audit trail for adjustments and payouts.
- AI agents cannot approve their own privilege escalation.

## 11. Reporting
Provide authorized reports for:
- Gross merchandise value.
- Collected payments.
- Refunds and chargebacks.
- Platform revenue.
- Merchant payables.
- Courier and shopper earnings.
- Taxes and fees.
- Reconciliation exceptions.
- Net cash flow.

## 12. Acceptance Criteria
- Every financial movement has a traceable reference.
- Ledger entries balance.
- Duplicate requests cannot duplicate charges or refunds.
- Merchant settlements reconcile to source transactions.
- Workforce earnings are auditable.
- Refunds preserve original payment references.
- Currency and legal entity are explicit.
- Access and approvals are enforced.

## 13. Implementation Status

Partial implementation — database foundation only; this is not a production settlement or payout system.

Implemented in migration 0049:
- Tenant- and currency-scoped double-entry accounts, journals and journal lines.
- A journal must balance before posting; posted journals and their lines are immutable.
- Idempotent journal writes are provided by the domain journal service.

Implemented in migration 0050:
- Merchant-scoped settlement batches and suborder lines.
- Settlement lines must reference a fulfilled suborder, match its recorded subtotal and order currency, and include a contract reference plus an arithmetically reconciled deduction breakdown.
- A suborder can appear in at most one settlement line.
- Approval requires a matching posted journal that debits CUSTOMER_FUNDS_HELD for gross proceeds, credits MERCHANT_PAYABLE for net proceeds, and allocates deductions to other credit accounts.
- Approved batches and their lines are immutable.
- A read-only merchant settlement details API is implemented for merchant owners/admins with an explicit `merchant.settlement:read` grant; it resolves tenant ownership server-side and returns batch lines without enabling approval or payout.
- Migration 0053 requires draft batches to have no journal reference and enforces one settlement batch per posted journal, preventing a journal from being reused to approve multiple batches.
- Migration 0054 enforces single-use provider references for payment adjustments within a tenant and provider namespace; legacy rows without a provider key share a guarded legacy namespace.
- Migration 0055 adds a tenant-scoped durable payment-adjustment submission outbox with a stable provider idempotency key, leased processing state, retry scheduling and dead-letter state. Queue creation is transactionally coupled to the adjustment's transition into provider-pending.
- Migration 0056 enforces the outbox's initial provider-pending identity, immutable adjustment/provider/idempotency identity, monotonic attempt count and permitted queue/lease/submitted/failed/dead-letter state transitions at the database boundary. Migration 0057 adds a terminal `reconciliation_required` quarantine state for requests whose provider outcome is ambiguous; the worker never automatically resubmits those requests. Migration 0058 binds each refund outbox entry to the exact verified original payment capture, enforces provider/currency/amount consistency, and makes that reference immutable. Refund submissions without a matching verified capture are rejected.
- A separate worker claims only the configured provider queue, submits the same idempotency key on retries, and persists provider acceptance plus the immutable adjustment event in one database transaction. Explicit rate-limit responses are rescheduled; ambiguous network failures, server errors, malformed success responses and unexpected post-submit worker errors are quarantined as `reconciliation_required` for manual/provider reconciliation. They are never blindly resubmitted. Exhausted leases are dead-lettered for reconciliation.
- The worker refuses to start unless `PAYMENT_ADJUSTMENT_ENVIRONMENT=sandbox` and sandbox endpoint/token settings are supplied. This is a generic HTTPS adapter contract, not a verified provider-specific Moyasar/HyperPay/Tap/Stripe implementation.

Not implemented or enabled:
- Contract/commission/tax policy calculation or independent verification of the supplied contract reference and deduction amounts.
- Authenticated API endpoints and server-side grant enforcement for the migration 0071 dual-control workflow.
- Provider payout execution, bank transfer, wallet transfer, payout confirmation, or settlement reconciliation against bank/provider statements.
- Refund execution or production money custody.
- Provider-specific Moyasar, HyperPay, Tap Payments and Stripe adjustment adapters, provider-specific webhook/reconciliation contract tests, and production activation. When `PAYMENT_ADJUSTMENT_PROVIDER_KEY` is configured, the customer consent endpoint now atomically records consent and queues the durable outbox; without that setting it records consent only. The generic HTTPS adapter/worker remains sandbox-only and is not a certified integration for any named provider.

The database approval transition is an accounting-record control, not evidence that a merchant was paid. No live payment, payout, bank account or money movement is claimed. Legal, regulatory, payment-provider and accounting review remains required before activation.


## 13A. Merchant Settlement Dual-Control Review (migration 0071)

Migration 0060 adds a two-person review record for a draft merchant settlement batch:

1. An authorized platform operator requests accounting authorization. The database locks the draft batch and captures an immutable snapshot of its line count, gross, deductions and net totals.
2. A different finance/platform approver records one decision: authorize accounting review or reject. The requester cannot approve their own request.
3. The database rechecks the settlement snapshot before accepting the decision. A changed snapshot is rejected.
4. Request and decision audit events are inserted in the same database transaction as their respective state changes. Decision records are append-only.
5. An authorized request reaches `authorized_for_accounting`; this is not a posted journal, not a transition of the settlement batch to `approved`, and not proof of payment.

The application must derive actor identity, active platform role and grants from the authenticated server-side session. Never accept requester/approver IDs, roles, tenant IDs or grants as trusted client-supplied values. Enforce explicit `merchant.settlement:request` and `merchant.settlement:approve` grants in the API; finance, platform_admin or platform_owner is the only eligible approver role. Merchant users and AI agents cannot request or approve this workflow.

**Remaining gated work:** a transaction-aware accounting service must map every deduction code to an explicitly configured financial account and atomically post the balanced journal, bind it to the settlement batch, and append the accounting audit event. The existing journal service owns its own transaction, so it must not be called followed by an independent batch update. Contract/commission/tax policy verification, payout provider adapters, bank transfer execution and payout reconciliation remain unimplemented. No live funds are moved by migration 0071.


## 13B. Versioned settlement policy and deduction account mappings (migration 0072)

Migration 0072 adds immutable, tenant/merchant/currency-scoped policy snapshots. Each snapshot records its contract reference, policy version, SHA-256 digest, JSON policy payload, approving actor and approval timestamp. Deduction codes are mapped to financial accounts within that exact policy snapshot; the database enforces tenant and currency matching and prevents duplicate codes, mutation, deletion or truncation.

A draft settlement batch may be bound once to a policy snapshot. Once bound, the binding cannot be changed, and newly inserted settlement lines must use the snapshot's contract reference. Existing historical batches remain nullable for backward compatibility; the new accounting-posting path must reject an unbound batch and must fail closed for any deduction code without exactly one mapping.

This migration provides immutable configuration evidence only. It does not independently validate the legal correctness of the policy payload, calculate commissions or taxes, post a journal, approve a batch, or initiate a payout. Those operations remain gated for the transaction-scoped accounting service and its integration tests.


## 13C. Atomic accounting posting (migration 0073)

The `post_merchant_settlement_accounting` database function is the transaction-scoped posting boundary. It locks the settlement batch and its independently authorized approval, checks the approval snapshot totals and immutable contract-policy binding, requires active ledger mappings for every deduction code, and writes the balanced journal, posts it, approves and links the batch, and appends an audit event in the caller's PostgreSQL transaction.

The function is idempotent for an already-approved batch and returns its existing journal identifier after rechecking the caller's allowed finance role and requester separation. Missing approval, policy, account mappings, or control accounts fail closed. The operation is ledger reclassification only: it does not call a payment provider, create a payout instruction, or transfer funds.

The API integration must call this function only after resolving the actor from a verified server-side session. The SQL role argument is a defense-in-depth allowlist, not a substitute for API authentication or database privilege management. Keep direct execute privileges restricted to the trusted application database role.


## 13D. Merchant payout authorization intents (migration 0074)

A payout intent can only be requested against an already-approved settlement batch with a posted settlement journal, and its amount must exactly match the sum of the batch's net merchant proceeds. One active request per batch is allowed; a rejected request may be replaced with a new idempotent request.

Payout authorization is a separate two-person control: the requester cannot authorize their own intent, decisions are append-only, and both request and decision are audited. An authorized intent is only permission for a future payout workflow. Migration 0074 deliberately contains no provider call, bank instruction, payout status claiming transfer completion, or storage of raw bank credentials. The next stage must add encrypted payout-destination references, a durable provider outbox, provider idempotency, webhook/reconciliation handling, and a separate disbursement journal after confirmed provider outcome.
