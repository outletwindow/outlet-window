# Outlet Window - Implementation Status

Last updated: 2026-11-07

## Engineering foundation
- [x] pnpm workspace and TypeScript configuration.
- [x] Fastify API foundation with health and readiness endpoints.
- [x] API foundation tests.
- [x] CI workflow for typecheck, tests, and build.
- [x] Domain package with deny-by-default authorization.
- [x] Authorization tests for tenant and branch isolation.

## In progress
- [ ] Persistent identity, user, role, and permission storage.
- [ ] Authentication, password/passkey flows, MFA, and session revocation.
- [ ] Database provider selection and versioned migrations.
- [x] Versioned audit event contract with recursive secret redaction and metadata limits.
- [x] API request correlation ID response header.
- [ ] Audit event persistence and protected access.
- [ ] API-level authentication and authorization integration.

## Not yet implemented
The customer, merchant, shopper, courier, admin, owner, payment, inventory, dispatch, AI operations, Telegram, and external integration applications are not yet operational. They remain scheduled in the implementation roadmap.

## Acceptance rule
A checkbox is marked complete only when code is present and automated checks or documented acceptance evidence verify it. A design document or interface alone is not proof of an operational feature.
