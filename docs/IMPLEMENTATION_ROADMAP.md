# Outlet Window - Implementation Roadmap

## Delivery policy
Implementation is performed in isolated branches. Each milestone must include code, tests, security review, acceptance evidence, and an owner decision before production use. No secrets or real customer data belong in source control.

## Milestone 0 - Engineering foundation (started)
- TypeScript monorepo using pnpm workspaces.
- Fastify API service with health, readiness, and versioned foundation endpoints.
- Strict TypeScript compiler settings.
- Automated API foundation tests.
- Environment example and ignore rules.

## Milestone 1 - Platform core
- Database selection and migrations.
- Shared domain contracts and error model.
- Authentication, sessions, tenant isolation, and role-based access control.
- Audit events and request correlation.
- CI build, test, typecheck, and dependency scanning.

## Milestone 2 - Commerce
- Merchant and branch registry.
- Product catalog and variants.
- Branch inventory adapters and stock confidence.
- Cart, multi-merchant order splitting, pricing, and order lifecycle.

## Milestone 3 - Workforce and fulfillment
- Shopper onboarding, eligibility, task marketplace, and evidence.
- Courier onboarding, vehicle capacity, dispatch, tracking, and proof of delivery.
- Handover custody events and expiring single-use verification codes.
- Invoice OCR and discrepancy review.

## Milestone 4 - Money movement
- Payment provider abstraction and signed webhook processing.
- Ledger, refunds, merchant settlements, courier earnings, and reconciliation.
- Country-specific currency, tax, and compliance configuration.

## Milestone 5 - Applications and control
- Customer application, merchant portal, shopper application, courier application.
- Admin portal and Owner Control Center.
- Telegram command interface with scoped permissions and approvals.
- AI agent registry, task orchestration, audit, and emergency stop.

## Milestone 6 - Pilot readiness
- End-to-end, security, privacy, performance, accessibility, and recovery tests.
- Jubail pilot configuration and merchant onboarding.
- Operational dashboards, incident runbooks, and release acceptance.

## Status vocabulary
Planned, In Progress, Blocked, Implemented, Tested, Accepted, Released.

A milestone is not accepted merely because its files exist. Tests and acceptance evidence are required.
