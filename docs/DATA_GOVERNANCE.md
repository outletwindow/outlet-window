# Outlet Window — Data Governance

Version: 1.0
Status: Draft for Phase 0
Project: Outlet Window

## 1. Purpose

This document defines how Outlet Window collects, classifies, accesses, processes, stores, shares, retains and deletes data.

The objective is to protect users, merchants, shoppers, couriers and the company while maintaining data quality, security, privacy and regulatory compliance.

## 2. Data Governance Principles

1. Collect only data necessary for a defined business purpose.
2. Use data only for authorized and disclosed purposes.
3. Assign clear ownership and access permissions.
4. Protect sensitive information throughout its lifecycle.
5. Maintain accurate, traceable and auditable records.
6. Apply retention and deletion rules based on legal and operational requirements.
7. Never treat AI-generated information as verified fact without appropriate validation.
8. Do not sell or disclose personal data without a lawful basis and required authorization.

## 3. Data Classification

| Classification | Examples | Minimum Protection |
|---|---|---|
| Public | Public merchant descriptions and published product information | Integrity controls |
| Internal | Internal operating procedures and non-public reports | Authenticated access |
| Confidential | Merchant contracts, customer profiles and business reports | Role-based access and encryption |
| Restricted | Identity documents, precise location, financial records, authentication secrets | Strict access, encryption, audit and additional safeguards |

Classification must be reviewed when data sensitivity or its intended use changes.

## 4. Data Domain Ownership

| Data Domain | Authoritative System |
|---|---|
| Customer identity and account | Identity & Access |
| Customer saved addresses | Customer Location |
| Merchant and branch profiles | Merchant Management |
| Product definitions | Catalog |
| Branch stock and reservations | Inventory |
| Orders and suborders | Order Management |
| Payments and settlements | Payments & Ledger |
| Courier profiles and eligibility | Courier Management |
| Shopper profiles and tasks | Shopper Task Management |
| Delivery assignments | Dispatch |
| Custody and handover evidence | Unified Handover |
| Invoice records and extracted fields | Invoice Intelligence |
| Support conversations | Customer Support |
| Audit events | Audit & Compliance |

## 5. Personal Data Categories

The platform may process the following categories when necessary and legally permitted:

- Customer account and contact details.
- Merchant owner and employee account details.
- Courier and shopper identity and eligibility information.
- Saved addresses and delivery locations.
- Order, payment, return and refund records.
- Product preferences and customer support history.
- Location data during authorized operational tasks.
- Uploaded images, receipts and delivery evidence.

Special categories of personal data must not be collected unless a specific lawful purpose and appropriate safeguards have been established.

## 6. Access Control

- Apply least-privilege access.
- Use role-based and, where needed, attribute-based permissions.
- Separate customer, merchant, shopper, courier, administrator and owner access.
- Restrict access to a merchant's own branches and records.
- Restrict employee access to assigned duties.
- Require stronger authentication for privileged accounts.
- Review permissions periodically and immediately after role changes.
- Revoke access when employment, contracts or authorization end.
- Log sensitive reads, exports, edits and administrative actions.

## 7. Data Security

- Encrypt network traffic using approved secure transport.
- Encrypt sensitive stored data using managed encryption keys.
- Store passwords using a secure password-hashing algorithm.
- Store API keys, tokens and credentials in a dedicated secrets manager.
- Never store authentication secrets in source code or ordinary logs.
- Apply database access restrictions and network segmentation.
- Maintain tested backups and recovery procedures.
- Monitor unauthorized access and suspicious data exports.

## 8. Location and Tracking Privacy

- Request location permission only when needed.
- Support manual address entry and map-pin selection.
- Track couriers only during authorized active tasks, subject to applicable law.
- Do not continuously track shoppers or customers without a justified and disclosed purpose.
- Limit access to precise location data.
- Define retention periods for location history.
- Do not expose one user's location to unrelated users.

## 9. AI Data Governance

AI agents must:
- Access only data authorized for their assigned task.
- Use the minimum data necessary.
- Respect user consent, contractual restrictions and applicable law.
- Avoid exposing personal data in prompts, logs or notifications unnecessarily.
- Identify generated content and distinguish it from verified source records.
- Keep traceable records of material AI-assisted decisions.
- Support human review for high-impact decisions.
- Never use private customer or merchant data to train external models without a valid legal basis and required authorization.

AI agents must not:
- Bypass access controls.
- Export unrestricted customer databases.
- Reveal secrets or authentication tokens.
- Re-identify anonymized individuals.
- Make final legal or regulatory determinations.

## 10. Data Retention and Deletion

A documented retention schedule must define:
- Data category.
- Purpose of processing.
- Applicable legal or contractual retention requirement.
- Retention duration or review trigger.
- Responsible system owner.
- Secure deletion or anonymization method.

Deletion requests must be evaluated against applicable legal obligations, financial recordkeeping requirements, disputes and legitimate retention needs.

Data that must legally be retained must be restricted from unrelated use.

## 11. Data Sharing and Third Parties

- Share data only with approved recipients and for defined purposes.
- Establish appropriate contracts and data-processing terms.
- Assess third-party security and privacy practices.
- Review international data transfers before enabling them.
- Minimize fields shared with payment providers, delivery partners and AI providers.
- Never share payment card secrets with merchants, couriers or AI agents.
- Record material third-party data access and transfers.

## 12. Data Quality and Integrity

- Validate required fields and formats.
- Track source, timestamp and update method.
- Detect duplicate and inconsistent records.
- Preserve historical versions where required.
- Use idempotency and transaction controls for critical updates.
- Do not silently overwrite conflicting financial, inventory or handover evidence.
- Route material discrepancies to authorized review.

## 13. Data Subject Requests

Provide a controlled workflow for eligible requests concerning:
- Access to personal data.
- Correction of inaccurate information.
- Deletion where legally applicable.
- Restriction or objection where applicable.
- Data portability where required.
- Consent withdrawal where consent is the legal basis.

Requests must be authenticated, recorded, assessed and handled within applicable legal deadlines.

## 14. Incident Management

Suspected data breaches must trigger:
1. Detection and recording.
2. Containment and access restriction.
3. Investigation and impact assessment.
4. Preservation of relevant evidence.
5. Notification to responsible privacy and security personnel.
6. Regulatory and affected-person notifications where legally required.
7. Remediation and recovery.
8. Post-incident review and corrective actions.

## 15. Governance Responsibilities

| Role | Responsibility |
|---|---|
| Company Owner | Overall accountability and risk acceptance |
| Data Governance Lead | Data policies, classification and quality |
| Security Lead | Technical safeguards and access security |
| System Owners | Data accuracy, access and retention within their domains |
| Privacy / Legal Advisor | Legal basis, privacy obligations and transfer assessments |
| AI Governance Lead | AI access, data use and decision traceability |
| Engineering Team | Secure implementation and technical enforcement |

Roles may be combined during the MVP, but responsibilities must remain explicit.

## 16. Audit and Monitoring

Maintain auditable records for:
- Privileged access.
- Sensitive data exports.
- Permission changes.
- Data corrections and deletion.
- AI access to restricted data.
- Third-party data transfers.
- Security incidents.
- Retention and deletion jobs.

Audit records must be protected against unauthorized modification and deletion.

## 17. Acceptance Criteria

- Every major data domain has an authoritative owner.
- Data classification is implemented.
- Access follows least-privilege principles.
- Sensitive data is encrypted and protected.
- Location tracking has clear purpose and limits.
- AI access is scoped and auditable.
- Retention and deletion rules are documented.
- Third-party data sharing is controlled.
- Data subject request workflows are defined.
- Incident response procedures are documented.

## 18. Regulatory Alignment

Before launch in each country, the company must identify and assess applicable privacy, cybersecurity, consumer protection, financial and data-transfer requirements.

For Saudi Arabia, the legal review must include the Personal Data Protection Law (PDPL), its implementing regulations and relevant guidance from the competent authorities.

This document is an engineering governance baseline, not a legal opinion or proof of regulatory compliance.

End of document.
