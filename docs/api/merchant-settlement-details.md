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

The API records audit events and rejects duplicate active merchant/provider identities. These identifiers are routing metadata, not bank credentials. Registration does not enable transfers or create a payout instruction.

Each payout destination must reference the immutable provider-entity registry row for the same tenant, merchant, and provider. The database rejects new or newly verified destinations without an active mapping, and the provider submission outbox rejects destinations whose mapping has been revoked. The payout worker also rechecks that mapping while claiming work; revocation therefore blocks future submissions even if a destination still carries a historical `verified` status. Legacy destinations without a mapping remain stored for audit/history but cannot be newly verified or submitted. Re-registering an entity does not silently rebind an old destination; a new destination must be registered against the new mapping.

These controls validate local identity linkage only. They do not verify a bank account with Moyasar, create or send a transfer, or confirm money movement.


## Merchant payout destination administration

Platform staff manage payout destinations through these routes:

- `GET /api/v1/platform/payout-destinations?tenantId=...&merchantId=...` lists safe destination summaries. Requires `platform.merchant_payout_destination:read` and a `finance`, `platform_admin`, or `platform_owner` role.
- `POST /api/v1/platform/payout-destinations` registers a destination. Required fields: `tenantId`, `merchantId`, `providerKey=moyasar`, `currency`, `providerEntityRegistryId`, and `vaultReference`. Platform admin/owner only. New destinations always start as `pending`.
- `POST /api/v1/platform/payout-destinations/:destinationId/verify` independently approves a pending destination. Requires the `approve` grant and a `finance`, `platform_admin`, or `platform_owner` role. The creator cannot approve their own destination.
- `POST /api/v1/platform/payout-destinations/:destinationId/revoke` permanently revokes a destination. Platform admin/owner only.

The database enforces creator attribution, pending-on-create, independent approval, immutable destination identity, and terminal revocation. Revocation requires an authenticated actor and timestamp (`revoked_by`, `revoked_at`); the actor and timestamp are immutable, and a revoked destination cannot be reactivated. A destination can be verified only while its linked provider entity remains active.

### Vault reference privacy

`vaultReference` is an opaque pointer supplied by a trusted vault integration or operator. This API stores it only for internal payout-worker resolution. It is never included in destination list/create/verify responses or audit metadata. No raw IBAN, bank account number, bank credentials, or provider secrets are accepted or stored by these endpoints. A vault service integration is not provided by this API surface; supplying a reference does not prove that the referenced secret exists or is valid.

The payout outbox also rejects a direct transition from `submitted` to `confirmed` unless the same transaction has first recorded a matching, signature-verified `payout_confirmed` provider event. The event table does not grant ordinary application roles insert/update/delete access; the trusted reconciliation function records the event and posts the balanced journal atomically. A provider acceptance response remains `submitted`, never `confirmed`.


### Failed, canceled, and returned payout reconciliation

The database now provides a trusted persistence function for verified `payout_failed`, `payout_canceled`, and `payout_returned` events. When invoked by a provider adapter after signature verification and exact event decoding, it records immutable provider evidence and opens a case in `merchant_payout_exception_cases`. The current Moyasar webhook decoder is still limited to `merchant_payout_paid`; the non-paid event adapter/HTTP routing is not yet wired, so these exception cases are not yet populated automatically from live webhook deliveries. The case starts as `open`; review status may progress to `under_review` and then `resolved`, with a resolution code, actor, and timestamp required for closure. Resolved cases are terminal.

The database function `record_verified_merchant_payout_exception` exact-matches the tenant, outbox, provider, provider reference, amount, currency, and expected outbox state. Re-delivery of the same verified provider event returns the original case; conflicting reuse of an event ID is rejected. A `payout_returned` event is accepted only for an already-confirmed payout.

**No automatic reversal is posted.** A returned transfer remains a finance reconciliation case until the underlying bank/provider movement and accounting treatment are independently reviewed. Any reversal journal must be a separate, balanced, approved accounting operation; this migration does not alter the original posted payout journal or claim that returned funds have been recovered.

These endpoints administer records only. They do not verify a bank account with Moyasar, initiate a transfer, or enable live payouts.
