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


## Payout provider entity registry

Platform administrators can register the immutable mapping between a local active merchant and the provider's platform merchant/entity identifiers:

- `GET /api/v1/platform/payout-provider-entities?tenantId=...` lists mappings (platform admin/owner only).
- `POST /api/v1/platform/payout-provider-entities` registers a mapping using `tenantId`, `merchantId`, `providerKey=moyasar`, `providerMerchantId`, and `providerEntityId`.
- `POST /api/v1/platform/payout-provider-entities/:entityId/revoke` revokes an active mapping. Revocation is terminal; create a new mapping after correcting provider-side identity.

The API records audit events and rejects duplicate active merchant/provider identities. These identifiers are routing metadata, not bank credentials. Registration does not enable transfers or create a payout instruction; provider eligibility and a separately approved destination/worker remain required.
