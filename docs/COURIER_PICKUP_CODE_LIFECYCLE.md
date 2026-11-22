# Courier pickup-code lifecycle

## Status

The database credential table and courier-side digest verification exist. The courier transition rejects an invalid code and commits the failed-attempt counter so the attempt limit cannot be bypassed by transaction rollback.

The end-to-end issuance and merchant handoff are not yet implemented. In particular, there is no merchant-authorized API that issues a code, no audited issuance event, and no merchant UI that displays the code to store staff. Do not treat pickup verification as production-ready until these pieces are delivered and tested.

## Required lifecycle

1. A courier accepts a dispatch offer. The platform creates the delivery task, but does not expose a pickup code to the courier.
2. The merchant branch confirms that the suborder is prepared and ready for pickup.
3. An authenticated employee or manager with an explicit `merchant.order:update` grant scoped to the exact merchant, branch, order, and suborder requests a pickup code.
4. The server generates a short, human-enterable code using a cryptographically secure random source. The code is never accepted from the merchant client.
5. In one database transaction, the server locks the task and suborder, verifies their tenant/merchant/branch relationship and allowed lifecycle state, revokes any previous live credential, stores only an HMAC digest using the server-side pickup-code pepper, and appends an immutable issuance audit event.
6. The server returns the plaintext code only in that authenticated issuance response. It must not be included in courier task/offer responses, logs, analytics, traces, or ordinary order payloads. The merchant interface must display it only to authorized branch staff.
7. The courier enters the code at the branch. The existing courier transition verifies the digest, consumes the credential once, and records pickup verification evidence. Failed attempts must persist and stop being accepted at the configured attempt limit.
8. Reissue creates a new code and revokes the old credential. The old code must never become valid again. Expired, consumed, or revoked codes cannot authorize pickup.

## Security and operational requirements

- Keep the pepper in the deployment secret store; never commit it or expose it to browser clients.
- Fail closed when pickup-code verification is not configured. Do not silently allow pickup without verification.
- Scope every issuance query by tenant, merchant, branch, order, suborder, and task relationship; never trust identifiers supplied by the browser without checking their relationship in PostgreSQL.
- Restrict issuance to authorized merchant roles and require a durable audit write before returning the plaintext code.
- Do not put plaintext codes in push notifications, courier APIs, QR URLs, or support tooling. If a QR workflow is later added, encode a short-lived opaque claim rather than the raw code.
- Apply a short expiry, a small attempt limit, and a cooldown/lockout policy. Rate-limit issuance and failed verification per task and actor.
- Ensure retries cannot accidentally create multiple active credentials. Use transaction locks and the existing one-live-credential database constraint.
- Keep pickup-code verification evidence append-only and separate from proof-of-delivery evidence.

## Acceptance tests required before release

- Only an authorized employee for the exact branch can issue or reissue a code.
- Cross-tenant, cross-merchant, cross-branch, wrong-order, and wrong-task attempts are denied without creating a credential.
- The database contains only the digest, never the plaintext.
- Reissue revokes the previous code and leaves exactly one active credential.
- A valid code is consumed once; a second use is rejected.
- Expired, revoked, malformed, and exhausted credentials are rejected.
- Failed attempts persist across requests and transactions and stop at the configured limit.
- Courier endpoints and offer responses never return the plaintext code or digest.
- Audit failure prevents issuance from being reported as successful.
