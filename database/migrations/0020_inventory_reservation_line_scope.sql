-- Enforce that every reservation line belongs to the exact merchant and branch
-- recorded by its reservation header. This prevents cross-branch stock leakage.
ALTER TABLE inventory_reservations
  ADD CONSTRAINT inventory_reservations_id_merchant_branch_unique
  UNIQUE (id, merchant_id, branch_id);

ALTER TABLE inventory_reservation_lines
  ADD CONSTRAINT inventory_reservation_lines_reservation_scope_fk
  FOREIGN KEY (reservation_id, merchant_id, branch_id)
  REFERENCES inventory_reservations (id, merchant_id, branch_id)
  ON DELETE RESTRICT;
