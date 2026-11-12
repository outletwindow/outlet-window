# Customer Delivery Photos and Preferences

Status: Domain contract implemented; customer UI, media storage, API persistence and courier integration are not implemented.

## Customer experience

The customer may optionally add delivery instructions for home delivery, store pickup or an eligible pickup point. Instructions can be edited or cleared before the order reaches the operational cutoff defined by Order Management.

### Multiple photos

- Allow up to 8 optional photos per order.
- Offer purpose labels: entrance, gate, parking, vehicle, meeting point and other.
- Allow a short caption per photo and a separate access note.
- Examples include a building entrance, gate, parked vehicle, parking bay or pickup meeting point.
- Photos are private order-supporting information, visible only to authorized staff assigned to fulfill that order and the customer.
- Do not expose these photos publicly, to other customers, or to unrelated merchants/couriers.
- Store media through an authorized media service; order records retain media asset IDs and metadata, not raw image bytes.
- Enforce upload type/size limits, malware scanning where available, access authorization, retention and deletion policies before production launch.
- Never use a photo alone as proof of identity, custody transfer or successful delivery.

### Optional contact and handover preferences

Each preference is independently optional and may be enabled, disabled or left unspecified:
- Contact by phone call.
- Contact by message through an approved in-app channel.
- Hand the order directly to the customer.
- Leave at the door (home delivery only, subject to local law, merchant policy and operational safety).
- Ring the doorbell.
- Do not ring the doorbell.
- No doorbell preference.

Call and message may both be selected. No contact preference means the customer has not selected a preferred channel; it does not prohibit legally or operationally required contact. A do-not-ring preference must be respected where safe and practical. The customer can explicitly choose ring the bell instead.

## Fulfillment rules

- Home delivery: apply the customer's selected contact, handover and doorbell preferences.
- Store pickup: show optional branch arrival photos and meeting-point instructions; validate the pickup code and recipient before handover. Never apply leave-at-door.
- Pickup point: show optional meeting-point/access photos and instructions; use the pickup point's verified collection process.
- If a preference conflicts with safety, law, merchant policy or the available fulfillment method, explain the conflict and request a revised choice; do not silently override it.
- Leaving an order unattended requires explicit customer selection and must be supported by the applicable market and fulfillment policy.
- Record the preference snapshot used for each fulfillment attempt so later edits do not rewrite historical evidence.
- A courier or shopper may record an exception if the location is inaccessible or the instruction cannot be followed.
- Delivery completion still requires the configured proof-of-delivery and custody checks.

## Acceptance criteria

- Customer can add, view, reorder and remove multiple photos, up to the configured limit.
- Customer can enable or disable each preference independently.
- Customer can choose call, message, both or neither.
- Customer can choose ring, do not ring or no preference.
- Customer can choose hand-to-customer or leave-at-door where eligible.
- Store pickup and pickup-point flows never offer unattended door delivery.
- Assigned fulfillment personnel see only the instructions for their authorized order.
- Photos and preferences are not treated as delivery proof.
- Preference changes are versioned/audited and do not alter historical fulfillment attempts.
- Automated tests cover validation, authorization, upload limits and conflicting preferences.

## Implementation boundary

This document and the domain validation contract do not claim that uploads, storage, customer screens, APIs, push notifications or courier screens are live. Those require separate implementation and tests.
