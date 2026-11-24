# Customer payment adjustment details API

## Read an adjustment

`GET /api/v1/customer/orders/:orderId/payment-adjustments/:adjustmentId`

This endpoint returns the authenticated customer's payment-adjustment summary and its immutable merchant/suborder allocation breakdown.

### Authorization and privacy

- Requires the `customer.order` resource with `read` action for the requested order.
- The authenticated actor must have the `customer` role.
- The data lookup is scoped to the platform tenant, order ID, adjustment ID, and authenticated customer ID.
- A record that does not belong to the customer is reported as `404 not_found`, the same as a missing record.
- The endpoint is read-only. It does not consent to, submit, or execute a charge or refund.
- Provider references and credentials are not part of this response.

### Successful response

The response body is the adjustment object itself and contains:

- `id`, `orderId`, and `currency`
- `direction`: `refund` or `additional_charge`
- `amountMinor`, `previousTotalMinor`, and `proposedTotalMinor` (integer minor currency units)
- `status` and `expiresAtUtc`
- `allocations`: one entry per immutable allocation, including `suborderId`, `merchantId`, `branchId`, `componentKind`, `amountMinor`, and `currency`

Allocation component kinds are `product_subtotal` and `delivery`.

### HTTP outcomes

| Status | Meaning |
| --- | --- |
| `200` | Adjustment details returned |
| `403` | Actor is not a customer |
| `404` | Adjustment/order/customer combination not found |
| `503` | Customer adjustment reader is not configured |

## Validation

The API and domain test suites cover successful allocation reads and customer-ownership isolation. CI is the authoritative validation gate; no live payment-provider operation is performed by this read endpoint.
