# Moyasar Sandbox Refund Validation Runbook

Status: Operational checklist — sandbox only

## Safety boundary

- This workflow is for Moyasar sandbox credentials and sandbox payments only.
- The refund submission worker intentionally refuses to start unless `PAYMENT_ADJUSTMENT_ENVIRONMENT=sandbox`.
- When `PAYMENT_ADJUSTMENT_PROVIDER_KEY=moyasar`, the worker requires `MOYASAR_SANDBOX_SECRET_KEY` to begin with `sk_test_`.
- Do not put live credentials in the worker environment, commit credentials, or paste credentials into tickets or chat.
- Do not enable a live refund worker as part of this validation. Live rollout requires a separate security and operational review.

## Provider contract reference

Validate this integration against Moyasar's current provider contract before running the scenarios:

- Refund endpoint: [POST /payments/:id/refund](https://docs.moyasar.com/api/payments/05-refund-payment). The request accepts an optional `amount` in the smallest currency unit, and the successful response is a payment snapshot containing `status`, `refunded`, `captured`, and `currency`.
- Payment operations guide: [Partial Refund](https://docs.moyasar.com/guides/payment-operations). Moyasar documents that a partial refund changes the payment status to `refunded`; paid payments are bounded by `amount`, while captured payments are bounded by `captured`.

The one-refund-operation-per-payment guard in migration `0062` is based on that documented status transition. Do not interpret the cumulative `refunded` field as evidence that another refund request can be submitted after the first partial refund.

## Required configuration

Set these values through the deployment secret manager or a protected local `.env` file:

| Variable | Sandbox requirement |
| --- | --- |
| `PAYMENT_ADJUSTMENT_ENVIRONMENT` | `sandbox` |
| `PAYMENT_ADJUSTMENT_PROVIDER_KEY` | `moyasar` |
| `MOYASAR_SANDBOX_SECRET_KEY` | Moyasar test secret key (`sk_test_...`) |
| `MOYASAR_WEBHOOK_SECRET` | Same webhook secret token configured for the sandbox webhook |
| `MOYASAR_EXPECT_LIVE` | `false` |
| `DATABASE_URL` | Isolated sandbox/test database |

The API's `MOYASAR_SECRET_KEY` must also be a sandbox key when creating sandbox payments. Keep the API key and refund-worker key separately scoped where the deployment supports it. Never use a live key to validate this runbook.

## Start and inspect the sandbox worker

1. Apply database migrations and confirm migration `0062_moyasar_single_refund_per_payment` is recorded in `schema_migrations`.
2. Validate Compose configuration: `docker compose config`.
3. Start only the opt-in sandbox profile: `docker compose --profile payment-adjustments-sandbox up -d --build`.
4. Inspect worker startup logs and confirm `environment=sandbox` and `providerMode=moyasar_refund_sandbox`.
5. If the worker refuses to start, stop and correct configuration. Do not bypass its environment or key checks.

## Required acceptance scenarios

Use a disposable sandbox order and a payment created in the same Moyasar sandbox account. Record the payment ID and expected amounts in the test evidence; never record credentials or card data.

1. **Partial refund succeeds**
   - Create and capture a sandbox payment.
   - Approve one partial refund through the platform's normal adjustment/consent flow.
   - Confirm the worker submits one refund request only.
   - Confirm the provider payment snapshot reports status `refunded` and the exact cumulative `refunded` amount.
   - Confirm the verified webhook applies the adjustment and updates the order total exactly once.

2. **Duplicate webhook is harmless**
   - Replay the exact same signed webhook event.
   - Expect a duplicate outcome; no second order, adjustment, or reservation transition may occur.

3. **Event identity collision is quarantined**
   - In an isolated test harness, reuse an event ID with a different payload.
   - Expect `event_id_collision`; do not apply the second payload.

4. **Uncertain submission is never blindly repeated**
   - In a controlled test harness, simulate a lost response after the refund POST may have reached the provider.
   - Expect an unknown/reconciliation-required outcome.
   - Reconcile using the read-only payment lookup and verified provider webhook evidence. Do not issue another refund POST automatically.

5. **A second Moyasar refund is blocked**
   - After the first partial refund is confirmed, attempt another adjustment against the same original payment.
   - Confirm it is rejected by the reservation/database guard before a second provider refund request is sent.

6. **Test/live webhook mode mismatch is rejected**
   - Send a sandbox webhook to an API configured for live mode, and vice versa, in an isolated test environment.
   - Expect signature/event rejection and no ledger mutation.

## Evidence to retain

- Commit SHA and successful CI run URL.
- Migration version and isolated database identifier (not its connection string).
- Sanitized worker outcome logs and timestamps.
- Sandbox payment ID, event ID, before/after cumulative amounts, and final platform adjustment status.
- Confirmation that duplicate delivery did not produce another mutation.

## Stop conditions

Stop the worker and mark the case for operator reconciliation if provider status, cumulative refunded amount, currency, payment identity, order total, or webhook identity does not match exactly. Never resolve an ambiguous refund by submitting a second refund request.

## Completion gate

Sandbox validation is complete only after all six acceptance scenarios pass with recorded evidence. A green CI run or mocked unit test alone does not count as a successful provider Sandbox test.
