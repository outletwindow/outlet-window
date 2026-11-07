# Outlet Window — Authorization & Permission Model

Document ID: OW-IAM-001
Version: 1.0
Status: Draft — Pending Security Review

## 1. Purpose
Define centralized identity authorization, roles, permissions, access boundaries and approval requirements across Outlet Window.

## 2. Core Principles
- Least privilege by default.
- Deny access unless explicitly authorized.
- Separate authentication from authorization.
- Enforce permissions on the server, not only in the user interface.
- Every privileged action must be attributable to an identity.
- AI agents cannot grant themselves permissions.
- Access must be revocable and reviewable.

## 3. Identity Categories
- Platform Owner.
- Platform Administrators.
- Operations Staff.
- Finance Staff.
- Security and Compliance Staff.
- Merchants and Merchant Employees.
- Customers.
- Shoppers.
- Couriers.
- Support Agents.
- AI Agents and Automation Services.
- External Integration Services.

## 4. Role-Based Access Control
Support configurable roles such as:
- Owner: platform-wide governance and approved critical decisions.
- Super Administrator: authorized platform administration within assigned scope.
- Operations Manager: operational monitoring and approved workflows.
- Finance Viewer: read-only financial reporting.
- Finance Operator: permitted finance workflows with approval controls.
- Security Auditor: security evidence and audit review.
- Merchant Owner: access to their own merchant organization.
- Branch Manager: access to assigned branches.
- Merchant Employee: assigned store tasks only.
- Customer: access to their own account and orders.
- Shopper: assigned shopping tasks.
- Courier: assigned delivery tasks.
- AI Agent: explicitly scoped capabilities.

## 5. Permission Structure
Permissions must be action-specific:
- read
- create
- update
- approve
- execute
- export
- delete
- manage_access

Permissions must also be scoped by:
- Platform.
- Country.
- City.
- Merchant.
- Branch.
- Order.
- Assigned task.
- Data category.

## 6. AI Agent Permissions
Each AI agent must have:
- A unique service identity.
- A defined business purpose.
- An approved permission set.
- Explicit resource scope.
- Execution limits.
- Audit logging.
- Expiry and revocation controls.

AI agents may analyze, recommend, draft code and execute approved development or testing tasks within their scope.

AI agents must not:
- Escalate their own privileges.
- Create unrestricted administrator accounts.
- Disable audit logging.
- Access unrelated customer or merchant data.
- Execute arbitrary production commands.
- Approve their own high-impact actions.

## 7. Approval Requirements
Require authorized human approval for:
- Production deployment of high-impact changes.
- Payment configuration changes.
- Financial transfers and exceptional refunds.
- Sensitive data exports.
- Account ownership changes.
- Privilege escalation.
- Destructive database operations.
- Disabling critical security controls.
- Changes to legal or compliance policies.

Approval requests must contain the action, reason, impact, requester and expiry.

## 8. Authentication and Sessions
- Support secure authentication methods.
- Enforce MFA for privileged accounts.
- Use secure session management.
- Apply session expiration and revocation.
- Detect suspicious authentication activity.
- Never store plaintext passwords.
- Never request passwords, OTPs or recovery codes through Telegram.

## 9. Separation of Duties
- A requester should not approve their own sensitive action.
- Financial preparation and financial approval should be separated where practical.
- AI agents must not independently authorize their own high-impact operations.
- Production deployment and code review should have separate controls for critical releases.

## 10. Tenant and Data Isolation
Merchant data must be isolated by merchant organization and authorized branch scope.

Customers must only access their own private records.

Shoppers and couriers must only access information required for their assigned tasks.

Cross-merchant access requires explicit authorized business purpose and server-side enforcement.

## 11. Access Reviews
- Review privileged accounts regularly.
- Review service and AI agent permissions.
- Revoke access immediately when no longer required.
- Record permission changes.
- Detect dormant or unusual accounts.
- Require reauthorization when scope changes.

## 12. Audit Requirements
Record:
- Identity and role.
- Requested action.
- Resource and scope.
- Authorization decision.
- Approval reference where required.
- Execution result.
- Timestamp and correlation ID.

Audit records must be protected against unauthorized modification.

## 13. Emergency Access
Emergency access must:
- Be time-limited.
- Require a documented reason.
- Notify authorized security personnel.
- Be logged and reviewed afterward.
- Never become a permanent privilege escalation path.

## 14. Testing and Acceptance Criteria
- Test unauthorized access denial.
- Test merchant and branch isolation.
- Test customer record isolation.
- Test AI agent permission boundaries.
- Test approval workflows.
- Test privilege revocation.
- Test emergency access expiry.
- Test audit completeness.
- Test API-level authorization independently of the interface.

## 15. Implementation Status
This document defines the intended authorization model. It does not claim that identity providers, permission services or approval workflows are already implemented.

Implementation requires architecture review, security testing and controlled rollout.

## API enforcement reference implementation
The API now includes a protected merchant-branch access-check route. It resolves the actor only through an injected server-side `resolveActor` function and delegates the decision to the shared domain `authorize` policy:
- No resolved actor returns HTTP 401.
- Inactive actors return HTTP 403.
- A merchant/branch scope mismatch returns HTTP 403.
- Only a matching explicit grant returns HTTP 200.

The client cannot supply its own role or grants through request headers or body. The default application configuration has no actor resolver, so the protected route denies access by default.

This route is a reference enforcement seam, not a complete authentication integration. The production resolver must validate a persisted session/token, load current account status and time-valid role assignments from trusted storage, and attach the actor server-side. Business data routes must use the same guard before reading or mutating records; database queries must independently include tenant and branch predicates. The access-check route itself returns no business data.

## Persisted-session actor resolution and protected branch data
The domain package now provides an actor-resolution service that:
1. Accepts only the documented bearer token format `<sessionId>.<opaqueSecret>`.
2. Uses an injected cryptographic adapter to digest the secret; raw secrets are not used as lookup keys.
3. Loads the stored session by opaque session ID and compares the digest.
4. Loads the principal and requires an active account.
5. Validates session ownership, revocation, absolute expiry and idle expiry.
6. Loads current role assignments, validates their scope and time window, then maps them through an injected role-to-grant policy.

The API can use this resolver through trusted infrastructure adapters. A merchant branch summary route demonstrates the required order: authenticate, authorize the exact merchant/branch scope, then call the branch repository. A denied request must not call the repository. The repository adapter is contractually required to include both merchant and branch predicates in its data query.

The role-to-grant policy and cryptographic digest adapter remain injected; no implicit broad role permissions are granted. Multiple distinct roles currently fail closed because the Actor contract represents one role. Production storage, token issuance, cryptographic implementation, concrete role policy, and business repository are not supplied by this reference implementation.
