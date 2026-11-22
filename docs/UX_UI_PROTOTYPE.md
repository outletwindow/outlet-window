# Outlet Window - UX/UI Prototype Specification

## 1. Design Vision
Create a consistent, accessible, multilingual, and scalable user experience across all Outlet Window applications. The design must be simple for everyday users while providing detailed operational controls for merchants and platform teams.

## 2. Design Principles
- Mobile-first for customer, shopper, and courier applications.
- Responsive web design for merchant and admin portals.
- Arabic and English support with right-to-left and left-to-right layouts.
- Consistent colors, typography, spacing, and reusable components.
- Clear navigation and accessible interaction patterns.
- Show features only when they are enabled and available in the user's market.
- Display prices, fees, delivery estimates, and task rewards transparently.
- Provide clear loading, empty, success, warning, and error states.

## 3. Customer Application
Main screens:
- Welcome, registration, and login.
- Location permission and manual address selection.
- Home page and merchant discovery.
- Categories, search, and filters.
- Merchant profile and branch information.
- Product listing and product details.
- Product variants, sizes, colors, and availability.
- Favorites and saved items.
- Multi-merchant shopping cart.
- Checkout and delivery method selection.
- Payment and order confirmation.
- Order tracking and delivery progress.
- Returns, cancellations, and support.
- Customer profile, addresses, and preferences.

## 4. Merchant Portal
Main screens:
- Merchant onboarding and verification status.
- Merchant dashboard and performance indicators.
- Branch management.
- Product catalog and product variants.
- Inventory levels and synchronization status.
- Incoming orders and order details.
- Order preparation and barcode verification.
- Pickup and handover confirmation.
- Returns and customer issues.
- Settlements, financial reports, and invoices.
- Staff accounts, roles, and permissions.
- Integration settings for POS, ERP, API, and CSV.

The portal must work on desktop, tablet, and mobile browsers.

## 5. Shopper Application
Main screens:
- Registration and identity verification.
- Shopper type and eligibility.
- Service areas and availability.
- Shopper home and available tasks.
- Task details, reward, and estimated effort.
- Accept or decline task.
- Shopping list and store navigation information.
- Barcode and SKU scanning.
- Size, color, and quantity verification.
- Item substitution request requiring customer approval where applicable.
- Bag and invoice evidence capture.
- Task completion and handover.
- Earnings, history, and performance.

Shopper workflows must support Mall Personal Shopper, Store Employee Shopper, Independent Shopper, and Mall Collector roles with appropriate permissions.

## 6. Courier Application
Main screens:
- Registration and identity verification.
- Vehicle and delivery capacity details.
- Availability and service areas.
- Courier home and task offers.
- Task details, compensation, and route.
- Accept or decline delivery.
- Navigation to pickup location.
- Pickup verification and handover.
- Active delivery map and ETA.
- Customer communication when permitted by workflow.
- Delivery verification and proof.
- Earnings, payouts, and task history.
- Support and incident reporting.

Location sharing must be limited to authorized active delivery workflows.

## 7. Admin Portal
Main screens:
- Operational overview.
- Customer and account management.
- Merchant and branch management.
- Shopper and courier management.
- Orders, suborders, and task monitoring.
- Inventory and integration exceptions.
- Delivery zones and service configuration.
- Payment, refund, and settlement monitoring.
- Support and dispute management.
- Audit, security, and incident reports.
- Role and permission management.

## 8. Owner Control Center
Main screens:
- Executive overview and business KPIs.
- Platform health and operational status.
- AI agent directory and health.
- AI task queue and execution history.
- Recommendations and opportunity reports.
- Security alerts and incidents.
- Approval inbox for sensitive actions.
- Development tasks, code review, and release status.
- Financial and infrastructure cost monitoring.
- Automation policies and emergency controls.
- Telegram bot connection and command history.

The Owner Control Center is the primary control interface. Telegram is a secondary command channel and must not bypass authorization or approval workflows.

## 9. Telegram Command Bot
- Secure owner authentication and authorization.
- Command help and supported command list.
- AI task submission and progress updates.
- Reports and alerts.
- Approval requests with clear action details.
- Confirmation before sensitive actions.
- Audit references for executed commands.
- No secrets, passwords, or payment credentials in messages.

## 10. Shared Design System
Create reusable components for:
- Buttons and input fields.
- Navigation bars and menus.
- Product cards and merchant cards.
- Order and task cards.
- Status indicators and progress steps.
- Maps and location panels.
- Barcode and QR scanning screens.
- Confirmation dialogs.
- Notifications and alerts.
- Tables, charts, and filters.
- Accessibility and localization components.

## 11. Core User Journeys
Prototype and test these journeys:
1. Customer discovers a product, purchases it, and tracks delivery.
2. Merchant receives and prepares a customer order.
3. Shopper accepts a task, collects products, and hands them over.
4. Courier accepts a delivery, collects the order, and completes delivery.
5. Mall Collector receives bags and completes a collection task.
6. Owner reviews an AI recommendation and approves or rejects it.
7. Admin resolves an order or delivery exception.

## 12. Design Deliverables
- Information architecture and navigation maps.
- User journey diagrams.
- Low-fidelity wireframes.
- High-fidelity screen designs.
- Reusable component library.
- Clickable prototypes.
- Arabic and English layouts.
- Responsive merchant and admin portal designs.
- Accessibility and usability review.

## 13. Design Acceptance Criteria
- Every core user journey can be completed in the prototype.
- Shopper and courier roles are clearly separated.
- All critical actions have confirmation and feedback states.
- Fees, rewards, and order statuses are understandable.
- Arabic RTL layouts are reviewed.
- Interfaces are usable on supported mobile and desktop screen sizes.
- Permissions and available features are reflected in the UI.
- Prototype feedback is recorded and resolved before development handoff.

## 14. Implementation Status
This document defines the UX/UI design scope. No production interface or clickable prototype has been implemented yet. Final designs must be reviewed and approved before engineering implementation.

Project: Outlet Window
Phase: Phase 0 - UX/UI Design
