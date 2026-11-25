# Merchant Payout Webhook Adapter Contract

Status: implementation contract; no provider adapter or public webhook endpoint is enabled by this document.

## Trust boundary

The shared processor is not a provider implementation. A provider adapter may be enabled only after the selected provider's official payout/disbursement documentation and sandbox behavior have been reviewed. Do not infer payout support from payment collection or refund support.

## HTTP ingress requirements

- Preserve the exact request body bytes received by the HTTP server. Do not parse and re-serialize JSON before signature verification.
- Enforce a request body limit before buffering and pass the original body plus only the required signature headers to the verifier.
- Normalize header names to lowercase at ingress; reject duplicate/ambiguous signature headers and malformed values.
- Do not log request bodies, signature values, secrets, bank details, or customer data.
- Apply provider-specific IP allowlisting only as defense in depth, never as a replacement for cryptographic verification.
- Return the provider-required acknowledgement only after the verified event has been durably recorded. Do not acknowledge an event that failed verification as accepted.

## Provider verifier requirements

Each provider adapter must document and test:
- Exact signature header names and encoding.
- Exact signed message construction, including raw body, timestamp, method/path, or delivery ID as required.
- HMAC/hash algorithm and constant-time comparison behavior.
- Secret rotation and multiple active signing keys if supported.
- Timestamp tolerance and replay protection requirements from the provider's official contract.

The verifier must validate the signature over the untouched body and required headers. It must reject missing, malformed, stale, or invalid signatures. Never accept a caller-supplied signature_verified boolean.

## Event normalization and reconciliation

Normalize only documented provider fields into:
- stable provider event ID;
- payout outbox ID or an unambiguous provider reference mapped to exactly one outbox record;
- provider transfer reference;
- positive integer amount in minor units;
- ISO 4217 currency;
- provider outcome and event creation time.

Before confirmation, the persistence layer must lock and exact-match the outbox record on tenant, provider, amount, currency, destination reference, and provider reference where available. A mismatch must be quarantined/rejected and must never post a payout journal.

## Idempotency and replay

- Enforce a unique provider + provider-event ID constraint in the database.
- A repeated delivery of the same verified event must return the previously recorded outcome without posting a second journal.
- Timestamp/replay checks are provider-specific and supplement, not replace, database idempotency.
- Different event IDs describing the same transfer must still reconcile against the same outbox and must not create a second disbursement.
- Unknown, unmatched, or contradictory events go to a restricted reconciliation queue; they must not be silently discarded or treated as paid.

## Required tests before enabling an adapter

1. Official valid signature fixture succeeds against the exact raw bytes.
2. Mutated body, missing signature, wrong secret, and malformed signature fail.
3. Required timestamp outside the provider's tolerance fails.
4. Replayed delivery is idempotent and cannot post a second journal.
5. Duplicate/ambiguous signature headers fail closed.
6. Correct event with wrong amount, currency, outbox, tenant, or destination is rejected/quarantined.
7. Provider timeout and acknowledgement loss reconcile without initiating a second transfer.
8. Secret resolver outage fails closed and does not decode or persist.
9. Concurrent duplicate deliveries create one provider event and one balanced payout journal.
10. No provider adapter or endpoint is enabled in production until sandbox evidence and the complete CI suite pass.

## Release gate

A provider adapter must remain disabled until its official payout webhook contract is linked in the implementation, all required signature/replay fixtures pass, PostgreSQL idempotency and exact-match integration tests pass, and finance/security owners approve the release. No live transfer is initiated by the shared webhook processor itself.