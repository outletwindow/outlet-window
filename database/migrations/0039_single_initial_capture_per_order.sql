-- An initial full-order capture is single-use per order, even across multiple provider intents.
-- If a second provider intent is captured, retain the first verified ledger row and fail the
-- second receipt as an identity collision; never accept two full charges for one order.
CREATE UNIQUE INDEX IF NOT EXISTS verified_order_payment_captures_one_per_order_idx
  ON verified_order_payment_captures (tenant_id, order_id);
