# Outlet Window

Global commerce and logistics platform connecting merchants, branches, inventory, customers, shoppers, couriers, and logistics providers.

## Product vision

Outlet Window is designed as a unified commerce and fulfillment network for physical and online retailers, with customer, merchant, shopper, courier, owner, and Telegram experiences.

## Engineering foundation

The repository currently contains:
- A pnpm workspace and TypeScript configuration.
- A Fastify API foundation with health and readiness endpoints.
- A PostgreSQL-backed API composition root for identity/session, branch, audit, integration registry, payment webhook inbox, order transition, and payment-adjustment adapters.
- Domain contracts for deny-by-default authorization, tenant/branch scoping, audit events, identity, scheduled fulfillment, task outbox/reconciliation, and payment webhook handling.
- Automated tests for API and domain behavior.
- CI configured for typecheck, tests, and build.

## Current implementation status

This is an active foundation and domain/API implementation, not yet a complete production marketplace.

Important work still required includes:
- Production authentication and complete IAM lifecycle, including MFA/passkeys and session revocation.
- Final database/infrastructure approval, migrations, and production persistence verification.
- Durable scheduled-task workers, transactional outbox adapter, reconciliation worker, alerting, and operator remediation UI.
- Payment provider capture/void/refund adapters and payment-to-order reconciliation.
- Live inventory reservation and cross-branch capacity aggregation.
- Operational customer, merchant, shopper, courier, admin, and owner applications.
- Production-ready Salla, Zid, Shopify, POS, ERP, mapping, and logistics integrations.
- Telegram bot and AI operations workflows.

See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for the detailed checklist and acceptance boundaries, and [docs/SCHEDULED_TASK_OUTBOX.md](docs/SCHEDULED_TASK_OUTBOX.md) for the scheduled fulfillment reliability contract.

## Security principles

- Deny access by default and enforce tenant/branch scope server-side.
- Never trust client-supplied roles or permissions.
- Keep secrets and payment credentials out of logs, task metadata, and API responses.
- Require explicit human approval for sensitive or irreversible actions.
- Audit protected operations and use idempotency for retried workflows.

## Development

The canonical workspace scripts and local setup instructions should be followed from the repository's package and CI configuration. Do not treat domain interfaces or in-memory test adapters as proof of a production integration.

## Project status

Foundation and selected domain/API capabilities are implemented. End-to-end production readiness has not yet been established.
