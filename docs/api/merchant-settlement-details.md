# Merchant settlement details API

## List settlement batches

`GET /api/v1/merchants/:merchantId/settlements?status=draft|approved&limit=50`

Returns a merchant-scoped list of settlement batch summaries, including currency, period, status, line count, and gross/deductions/net totals. The optional status filter accepts only `draft` or `approved`; the optional limit is an integer from 1 to 100 and defaults to 50. The response shape is `{ "batches": [...] }`.

The same authentication, merchant role, tenant resolution, and `merchant.settlement:read` authorization rules apply.

## Read a settlement batch

`GET /api/v1/merchants/:merchantId/settlements/:batchId`

Returns a read-only projection of one merchant settlement batch and its settlement lines.

### Authorization and privacy

- Requires an authenticated `merchant_owner` or `merchant_admin` actor.
- Requires the `merchant.settlement` resource with the `read` action scoped to the requested `merchantId`.
- The API resolves the merchant's tenant from trusted persistence; it does not accept a tenant ID from the client.
- The database lookup is scoped by tenant, merchant, and batch ID.
- A missing batch and a batch outside the merchant scope both return `404 not_found`.
- Merchant employees and branch managers cannot read settlement details through this endpoint, even if another broad grant is present.
- Amounts are returned as integer minor currency units. Unsafe integer values are rejected rather than rounded.

### Response

The response includes batch identity, currency, period, status, creation/approval timestamps, and `lines`.

Each line includes:
- order, suborder, and branch references
- contract reference
- gross, deductions, and net minor-unit amounts
- deduction breakdown entries with a code and amount

Draft batches without lines return an empty `lines` array.

### HTTP outcomes

| Status | Meaning |
| --- | --- |
| `200` | Settlement details returned |
| `401` | Unauthenticated |
| `403` | Missing scoped grant or insufficient merchant role |
| `404` | Merchant or batch not found in the authorized scope |
| `503` | Reader or merchant-tenant resolver is not configured |

## Safety boundary

This endpoint is read-only. It does not create or approve settlement batches, post accounting journals, initiate bank transfers, or confirm merchant payouts. Approval and payout execution remain separate controlled workflows.


## Platform dual-control approval endpoints

These routes are for authenticated platform staff, not merchant accounts:

### Request accounting authorization

`POST /api/v1/platform/settlements/:batchId/approval-requests`

- Requires the `platform.merchant_settlement:create` platform-scoped grant.
- Requester roles: `operations`, `finance`, `platform_admin`, or `platform_owner`.
- The API derives requester identity and role from the authenticated session. Client-supplied identity, role, tenant or merchant values are ignored.
- The database locks the batch, requires `draft`, snapshots line count and totals, and appends the audit event in the same transaction.
- A second pending request for the same batch is rejected.

### Record an independent decision

`POST /api/v1/platform/settlement-approval-requests/:requestId/decision`

Example body:

```json
{ "decision": "authorize_accounting", "reason": "Reviewed supporting settlement evidence" }
```

Use `reject` to decline the request. Approver roles are `finance`, `platform_admin`, or `platform_owner`. The requester cannot approve their own request. The database rechecks the snapshot and atomically records the decision, updates the request state and appends its audit event.

A successful `authorize_accounting` result means only `authorized_for_accounting`. It does not approve the settlement batch, post a journal, or initiate a payout. The current endpoints intentionally do not perform those actions.

### List pending approvals

`GET /api/v1/platform/settlement-approval-requests?limit=50`

Returns pending review requests ordered oldest-first. Requires the platform-scoped `platform.merchant_settlement:read` grant and a `finance`, `platform_admin`, or `platform_owner` role. The limit is an integer from 1 to 100 and defaults to 50. Operations requesters cannot browse the finance review queue.


## Platform accounting posting endpoint

`POST /api/v1/platform/settlements/:batchId/post-accounting`

This endpoint is restricted to authenticated `finance`, `platform_admin`, or `platform_owner` actors with the explicit platform-scoped `platform.merchant_settlement:execute` grant. The tenant is resolved from the immutable settlement batch row in trusted persistence; request-body tenant or actor identifiers are ignored.

Before posting, the accounting service locks the batch and requires exactly one `authorized_for_accounting` dual-control approval, a bound immutable policy snapshot, a matching contract reference, complete deduction-account mappings, and active same-tenant/same-currency ledger accounts. It then creates and posts a balanced double-entry journal, changes the batch to `approved`, and appends its audit event in one PostgreSQL transaction. A stable idempotency key and the batch row lock make retries safe.

### Outcomes

| Status | Meaning |
| --- | --- |
| `201` | Journal posted and batch approved |
| `200` | Idempotent retry; existing journal returned |
| `401` / `403` | Missing identity, grant, or platform finance role |
| `404` | Settlement batch not found |
| `409` | Missing approval, policy, or account mapping; or idempotency conflict |
| `503` | Accounting service unavailable |

This endpoint performs accounting posting only. It does not initiate a PSP refund, bank transfer, or merchant payout. Payout execution remains a separate workflow and requires its own provider reconciliation and controls.


## Provision an immutable merchant settlement policy

`POST /api/v1/platform/merchants/:merchantId/settlement-policies`

Requires an authenticated `finance`, `platform_admin`, or `platform_owner` actor with the platform-scoped `platform.merchant_settlement:approve` grant. The API supplies the approver identity from the authenticated session; caller-provided `approvedBy` or role fields are ignored.

Example body:

```json
{
  "currency": "SAR",
  "contractReference": "merchant-contract-2026",
  "policyVersion": "2026-01",
  "policyPayload": { "platformFeeBasisPoints": 500 },
  "mappings": [
    { "deductionCode": "platform_fee", "accountCode": "PLATFORM_FEE_REVENUE" }
  ]
}
```

The provisioner resolves the merchant tenant from trusted persistence, verifies every referenced account exists and is active for that tenant and currency, hashes canonicalized policy JSON with SHA-256, and inserts the immutable snapshot, deduction mappings, and audit event in one transaction. Repeating the same policy version with the same hash and exact mappings returns the existing snapshot; reusing that version with different content or mappings is rejected.

### Outcomes

| Status | Meaning |
| --- | --- |
| `201` | New immutable policy snapshot created |
| `200` | Exact duplicate; existing snapshot returned |
| `400` | Invalid policy or mapping input |
| `403` | Missing platform finance approval authority |
| `404` | Merchant not found or inactive |
| `409` | Missing/inactive ledger account or policy-version collision |
| `503` | Policy provisioner unavailable |

A policy snapshot is configuration evidence. It does not create a settlement batch, post accounting entries, or initiate any payout.


## Settlement policy snapshot provisioning

`POST /api/v1/platform/merchants/:merchantId/settlement-policies`

This endpoint is available to authenticated finance, platform administrator, or platform owner actors with the platform-scoped `platform.merchant_settlement:approve` grant. The approver identity and role are taken from the authenticated actor; client-supplied identity fields are ignored.

The request defines the currency, contract reference, immutable policy version and JSON policy payload, plus deduction-code to ledger-account-code mappings. The server resolves the merchant tenant from trusted persistence, verifies every mapped account exists, is active, and belongs to that tenant and currency, then stores the canonical SHA-256 policy snapshot, all mappings, and a high-severity audit event in one transaction.

A policy version is immutable. Repeating the same version with the same policy hash and exact mappings returns the existing snapshot; changing either returns a conflict. Missing/inactive accounts fail closed. A policy snapshot is not retroactively applied to existing batches: a batch must be explicitly bound while still draft, and its contract reference must match every settlement line.

| Status | Meaning |
| --- | --- |
| `201` | New policy snapshot and mappings created |
| `200` | Exact idempotent duplicate |
| `401` / `403` | Missing identity, grant, or approver role |
| `404` | Merchant not found or inactive |
| `409` | Account missing/inactive or policy version collision |
| `503` | Policy provisioner unavailable |
