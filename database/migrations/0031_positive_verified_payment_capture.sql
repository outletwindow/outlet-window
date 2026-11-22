-- Align the database invariant with the verified-capture domain boundary.
-- A payment capture must represent a strictly positive amount.
ALTER TABLE verified_order_payment_captures
  DROP CONSTRAINT IF EXISTS verified_order_payment_captures_amount_minor_check;
ALTER TABLE verified_order_payment_captures
  ADD CONSTRAINT verified_order_payment_captures_amount_minor_positive
  CHECK (amount_minor > 0);
