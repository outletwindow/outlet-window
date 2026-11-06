# Outlet Window - Decision Register

## 1. Purpose
Maintain a single traceable record of important product, business, architecture, security, and operational decisions.

## 2. Decision Record Fields
Each decision must include:
- Decision ID.
- Title and description.
- Date proposed and date approved.
- Status: Proposed, Approved, Rejected, Superseded.
- Decision owner and approver.
- Business and technical rationale.
- Affected systems and documents.
- Risks, dependencies, and alternatives.
- Review date, when applicable.

## 3. Initial Approved Directions

### OW-DEC-001: Hybrid Development Model
Status: Approved direction.
- Founder owns product vision and business decisions.
- Internal technical leadership oversees architecture.
- External developers implement under company governance.
- Independent QA and security review are required.

### OW-DEC-002: AI-First Operations
Status: Approved direction.
- AI agents assist engineering, security, QA, operations, finance, logistics, and business intelligence.
- Agents operate with limited permissions and auditable workflows.
- High-impact actions require human approval.

### OW-DEC-003: Owner Control Center
Status: Approved direction.
- A central owner dashboard manages oversight, approvals, and reporting.
- Telegram is a controlled command interface, not the system of record.

### OW-DEC-004: Separate Shopper and Courier Roles
Status: Approved direction.
- Shopper and courier functions use distinct role permissions and workflows.
- A person may qualify for one or both roles, subject to local rules and eligibility.

### OW-DEC-005: Modular Global Platform
Status: Approved direction.
- The platform is designed for local, national, and international expansion.
- Features are enabled by market and operational readiness.

### OW-DEC-006: Company Ownership of Technical Assets
Status: Target requirement; legal implementation pending.
- Company-controlled source code, domains, cloud accounts, documentation, and intellectual property.
- Written assignment and handover requirements for contractors.

## 4. Pending Decisions
- Legal entity jurisdiction and company structure.
- Final MVP scope and launch acceptance criteria.
- Final technology stack and cloud provider.
- Payment collection and merchant settlement model.
- Pricing, delivery fees, shopper rewards, and courier compensation.
- Final budget and vendor selection.
- Country-specific legal and regulatory approvals.

## 5. Change Control
- Never silently overwrite an approved decision.
- Record the reason and impact of every proposed change.
- Obtain approval from the authorized owner.
- Update affected architecture and implementation documents.
- Preserve the history of superseded decisions.

## 6. AI Agent Rules
- Agents may propose decisions and prepare impact assessments.
- Agents must not mark their own proposals as human-approved.
- Agents must reference the relevant decision ID when performing related work.
- Conflicts between documents must be escalated for resolution.

## 7. Status
This register records approved directions and unresolved decisions. It does not imply that planned systems have been implemented or legally approved.

Project: Outlet Window
Phase: Phase 0 - Decision Management
