-- A merchant suborder may have at most one non-terminal courier assignment.
-- Existing conflicting rows intentionally fail migration so operators reconcile them first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM courier_delivery_tasks
    WHERE status NOT IN ('declined','cancelled','failed')
    GROUP BY tenant_id, suborder_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'multiple active courier assignments exist for a suborder';
  END IF;
END $$;

CREATE UNIQUE INDEX courier_delivery_tasks_one_active_assignment_per_suborder_idx
  ON courier_delivery_tasks (tenant_id, suborder_id)
  WHERE status NOT IN ('declined','cancelled','failed');
