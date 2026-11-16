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
- Migration 0053 requires draft batches to have no journal reference and enforces one settlement batch per posted journal, preventing a journal from being reused to approve multiple batches.
- Migration 0054 enforces single-use provider references for payment adjustments within a tenant and provider namespace; legacy rows without a provider key share a guarded legacy namespace.
- Migration 0055 adds a tenant-scoped durable payment-adjustment submission outbox with a stable provider idempotency key, leased processing state, retry scheduling and dead-letter state. Queue creation is transactionally coupled to the adjustment's transition into provider-pending.
- Migration 0056 enforces the outbox's initial provider-pending identity, immutable adjustment/provider/idempotency identity, monotonic attempt count and permitted queue/lease/submitted/failed/dead-letter state transitions at the database boundary. Migration 0057 adds a terminal `reconciliation_required` quarantine state for requests whose provider outcome is ambiguous; the worker never automatically resubmits those requests.
- A separate worker claims only the configured provider queue, submits the same idempotency key on retries, and persists provider acceptance plus the immutable adjustment event in one database transaction. Explicit rate-limit responses are rescheduled; ambiguous network failures, server errors, malformed success responses and unexpected post-submit worker errors are quarantined as `reconciliation_required` for manual/provider reconciliation. They are never blindly resubmitted. Exhausted leases are dead-lettered for reconciliation.
- The worker refuses to start unless `PAYMENT_ADJUSTMENT_ENVIRONMENT=sandbox` and sandbox endpoint/token settings are supplied. This is a generic HTTPS adapter contract, not a verified provider-specific Moyasar/HyperPay/Tap/Stripe implementation.

Not implemented or enabled:
- Contract/commission/tax policy calculation or independent verification of the supplied contract reference and deduction amounts.
- An authenticated approval API or dual-control workflow.
- Provider payout execution, bank transfer, wallet transfer, payout confirmation, or settlement reconciliation against bank/provider statements.
- Refund execution or production money custody.
- Provider-specific Moyasar, HyperPay, Tap Payments and Stripe adjustment adapters, provider-specific webhook/reconciliation contract tests, and production activation. When `PAYMENT_ADJUSTMENT_PROVIDER_KEY` is configured, the customer consent endpoint now atomically records consent and queues the durable outbox; without that setting it records consent only. The generic HTTPS adapter/worker remains sandbox-only and is not a certified integration for any named provider.

The database approval transition is an accounting-record control, not evidence that a merchant was paid. No live payment, payout, bank account or money movement is claimed. Legal, regulatory, payment-provider and accounting review remains required before activation.
