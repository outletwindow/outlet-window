-- A single provider handover reference must never consume multiple reservations
-- within one tenant. Provider adapters should namespace references by provider.
CREATE UNIQUE INDEX inventory_reservations_handover_evidence_unique
  ON inventory_reservations (tenant_id, handover_reference)
  WHERE status = 'consumed' AND handover_reference IS NOT NULL;
