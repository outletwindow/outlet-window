# Outlet Window — Customer Identity & Access Management

Document ID: OW-IAM-001
Version: 1.0
Status: Draft — Pending Technical and Security Review

## 1. Purpose
Establish a centralized, secure identity and access management system for all Outlet Window applications, portals, APIs, employees and AI agents.

## 2. Supported Account Types
- Customer
- Merchant Owner
- Merchant Administrator
- Merchant Employee
- Branch Manager
- Order Receiver
- Picker and Packer
- Courier
- Mall Personal Shopper
- Store Employee Shopper
- Independent Shopper
- Mall Collector
- Customer Support Agent
- Operations Employee
- Finance Employee
- Auditor
- Security Administrator
- Platform Administrator
- Platform Owner
- AI Agent Service Identity

## 3. Identity Architecture
- Central Identity and Access Management (IAM) service.
- Unique internal identifier for every user and service identity.
- Authentication and authorization must be separate.
- One person may hold multiple approved roles.
- Each role operates within explicitly assigned permissions.
- Human accounts and AI service identities must remain separate.
- Identity records must not be duplicated across applications.

## 4. Registration and Login
- Support email and phone registration where available.
- Verify contact information before granting relevant account privileges.
- Secure password authentication.
- Support passkeys where technically available.
- Support biometric authentication through device capabilities.
- Require multi-factor authentication for privileged accounts.
- Support single sign-on where appropriate.
- Provide secure account recovery.
- Apply rate limits and protection against automated login attacks.

## 5. Role-Based Access Control (RBAC)
- Define roles and permissions centrally.
- Apply least-privilege access.
- Support permissions at platform, country, city, merchant and branch levels.
- Restrict merchant employees to their authorized merchant data.
- Restrict branch employees to assigned branches.
- Separate financial, operational, support and security permissions.
- Prevent unauthorized privilege escalation.
- Evaluate permissions on the server for every protected action.

## 6. Multi-Role Accounts
A person may be approved as both a shopper and courier.
- Each task must use the correct role.
- Role switching must be explicit.
- Permissions must be checked for every task.
- Conflicting permissions must be denied.
- Employment contracts and working-hour restrictions must be respected.
- Store employees must not access or prepare orders outside their authorization.

## 7. Identity Verification
- Apply verification requirements according to country, role and applicable law.
- Support approved identity verification providers.
- Store verification status and only the minimum necessary evidence.
- Protect identity documents and sensitive personal data.
- AI assessments must never be treated as conclusive identity verification.
- Uncertain cases must be escalated for human review.
- Re-verification must follow risk-based and legal requirements.

## 8. Session and Device Security
- Secure session and refresh tokens.
- Token rotation and expiration.
- Ability to revoke active sessions.
- Display active devices where appropriate.
- Rate-limit authentication attempts.
- Detect unusual login and device activity.
- Protect against session theft and account takeover.
- Require re-authentication for sensitive account changes.

## 9. AI Agent Identities
- Every AI agent must have a separate service identity.
- Each agent receives explicitly assigned permissions.
- Agents cannot grant themselves additional permissions.
- Agents cannot disable audit logging.
- Agents cannot access secrets outside their approved scope.
- Sensitive actions must use the central approval workflow.
- Agent identities must be revocable independently.
- Agent actions must identify the agent and initiating workflow.

## 10. Owner and Administrator Protection
- Strong multi-factor authentication.
- No shared administrator accounts.
- Restricted privileged sessions.
- Approval for high-impact access changes.
- Emergency access with strict audit logging.
- Periodic access reviews.
- Separation of duties for sensitive financial and security operations.
- Recovery procedures must not bypass security controls.

## 11. Privacy and Data Protection
- Collect only necessary personal data.
- Encrypt sensitive data in transit and at rest.
- Apply retention and deletion policies.
- Support applicable privacy rights.
- Restrict access to identity documents.
- Record access to sensitive records.
- Separate personal data from public profile information.
- Apply country-specific data protection requirements.

## 12. Audit Events
Record:
- Registration and verification changes.
- Successful and failed login attempts.
- Password and recovery changes.
- Role and permission changes.
- Device registration and session revocation.
- Privileged access.
- AI agent actions.
- Administrative approvals and denials.
- Security alerts and account restrictions.

Audit records must be tamper-resistant and access-controlled.

## 13. Account Lifecycle
- Pending verification.
- Active.
- Temporarily restricted.
- Suspended.
- Recovery pending.
- Closed.
- Deletion requested.
- Deleted or retained according to applicable legal obligations.

All lifecycle transitions must be authorized and auditable.

## 14. Integration Requirements
IAM must integrate with:
- Customer App.
- Merchant Portal.
- Shopper App.
- Courier App.
- Admin Portal.
- Owner Control Center.
- Telegram Command Bot.
- API Gateway.
- Central AI Agent Orchestrator.
- Audit and Security Monitoring.

Applications must not create independent permission systems that conflict with central IAM.

## 15. Acceptance Criteria
- Users can access only authorized resources.
- Merchant and branch data remain isolated.
- Multi-role permissions are enforced.
- Privileged accounts require stronger authentication.
- Sessions can be revoked.
- AI agents have isolated identities and permissions.
- Sensitive changes are audited.
- Account recovery resists account takeover.
- Unauthorized access attempts are detected and restricted.
- Security tests verify authorization at API level.

## 16. Implementation Status
This document is a design specification only. No live identity provider, authentication service, verification provider or access-control system is claimed to be operational.

Implementation requires architecture review, security testing, privacy review and approval before production deployment.
