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
