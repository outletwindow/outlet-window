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

## Moyasar-specific findings (official documentation reviewed 2026-11-25)

The following facts are documented by Moyasar and must shape any future adapter:

- The Payouts API creates transfers from a configured payout account to a bank or wallet beneficiary. It requires a source payout account and a destination of a matching type.
- The payout create request supports a caller-generated UUID v4 field named given_id; retrying with the same value returns the same payout. Use the durable outbox ID or a stable derived UUID as this idempotency key, never generate a new value for a retry.
- Payout amounts are integer minor units. The API response distinguishes queued, initiated, paid, failed, canceled, and returned. Only a verified paid outcome may enter the confirmed payout journal; returned must be represented as a reversal/exception, not silently left as paid.
- Moyasar explicitly states that its Payouts API does not transfer the current balance held at Moyasar to a bank account; platform settlements are handled separately. Outlet Window must not assume the Payouts API can disburse the platform's collected settlement balance to merchants. Confirm the source-funding model and contractual eligibility with Moyasar before selecting it for marketplace merchant settlements.
- Platform webhooks can opt in to merchant payout events, including merchant_payout_initiated, merchant_payout_paid, merchant_payout_failed, merchant_payout_canceled, and merchant_payout_returned. Merchant events are opt-in when registering the platform webhook.
- Moyasar documents an event envelope containing id, type, created_at, secret_token, account_name, live, and data; platform merchant events additionally include merchant_id and entity_id. It also documents the HTTP headers X-Event-ID, X-Event-Type, X-Event-Attempt-Number, and X-Event-Secret.
- This is a shared-secret token scheme as documented, not evidence of an HMAC signature over the raw body. An adapter must compare the configured secret with both the body secret_token and X-Event-Secret using constant-time comparison, and verify header/body event ID and type consistency. Do not label this HMAC verification.
- Moyasar requires webhook registration verification in some cases. A webhook with verified=false receives a one-time webhook_verification event containing a six-digit code; verify it through the documented verification endpoint before relying on event delivery.
- Moyasar advises queueing work and responding quickly; its platform webhook documentation specifies delivery timeouts and retries. The endpoint should durably persist the verified event before returning 2xx, then process it asynchronously.

Official references:
- Platform webhooks and merchant payout event list: https://platform-docs.moyasar.com/guides/webhooks
- Payout creation, given_id idempotency, amount units, and response statuses: https://docs.moyasar.com/api/payouts/04-create-payout
- Payout account and source-account requirements: https://docs.moyasar.com/guides/payouts/payout-account-details
- Payout flow and status details: https://docs.moyasar.com/guides/payouts/payout-details

## Additional Moyasar release gates

1. Obtain written confirmation from Moyasar that the Outlet Window platform account and intended marketplace model are eligible to use the Payouts API for merchant disbursements.
2. Confirm how the payout source account is funded and whether it can lawfully/contractually fund the intended merchant payouts. The current-balance limitation above is a blocker until resolved.
3. Build the adapter against official sandbox fixtures for every documented payout event, including paid, failed, canceled, and returned.
4. Compare the shared secret in both documented locations in constant time; reject mismatched event ID/type headers and body values.
5. Verify live/test mode, merchant_id, entity_id, payout ID, exact amount, currency, and the locally mapped outbox record before any state transition.
6. Treat initiated as submitted, paid as confirmed, failed/canceled as terminal failure subject to reconciliation, and returned as a reversal requiring a separate accounting workflow.
7. Use the same given_id for all create-payout retries and reconcile ambiguous timeouts by fetching payout state before any further attempt.
