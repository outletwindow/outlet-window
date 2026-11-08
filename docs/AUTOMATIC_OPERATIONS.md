# Automatic runtime operations

## What starts automatically

The Compose deployment starts the API, scheduled outbox publisher, and payment webhook consumer as separate long-running services. Each uses Docker's `unless-stopped` restart policy, an init process, bounded JSON-file logs, and a graceful stop window. The API exposes its readiness probe at `/ready`.

The one-shot migration service runs before the API and default workers. It uses the existing advisory-locked migration runner. A failed migration blocks dependent services instead of starting the application against a partial schema.

The fulfillment consumer is deliberately behind the `fulfillment` profile. It must not claim merchant/shopper/courier work until all three HTTPS provider endpoints and credentials have been supplied and their provider contracts have been validated. Enable it with:

```bash
docker compose --profile fulfillment up -d --build
```

## First deployment

1. Provision a persistent PostgreSQL database with TLS, backups, monitoring, and a tested restore procedure.
2. Copy `.env.example` to `.env` on the deployment host and set the real database connection. Keep `.env` out of Git.
3. Build and start the default services:

```bash
docker compose up -d --build
```

4. Check service state and logs:

```bash
docker compose ps
docker compose logs --tail=100 api scheduled-worker payment-webhook-worker migrate
```

5. Once the three real fulfillment providers are configured and sandbox-tested, enable the fulfillment profile.

## Important boundaries

- GitHub Actions CI is not a production host. Adding this Compose stack does not deploy it to a server.
- A production host or container platform, database URL, TLS, secrets, and provider credentials are external prerequisites. No live deployment is claimed by this repository change.
- The payment webhook intake currently still requires a provider secret resolver and provider-specific signature adapters. Do not enable live payment capture/refund on the basis of the generic canonical-envelope HMAC route.
- Scheduled reconciliation, recurring expiry processing, alert delivery, and several other planned domain workers are not implemented yet. They must be added as real consumers before they can be supervised here.
- Do not run multiple copies of the same logical scheduler unless its database claim/lease contract is explicitly safe for concurrent replicas.
- Use a deployment platform's health-based restart and alerting features; a Docker restart policy only restarts exited containers and is not a substitute for queue-lag, dead-letter, or business-level monitoring.
