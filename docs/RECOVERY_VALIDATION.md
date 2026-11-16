# Recovery validation

This branch restores the complete tracked source tree from `work/outlet-window-build` and carries two targeted changes:

1. Checkout line totals use PostgreSQL `numeric` operands before multiplication to avoid intermediate `bigint` overflow.
2. The external inventory reservation evidence integration fixture reads the exact reservation expiry timestamp. The previous fixture called `now() + interval '15 minutes'` twice, which can produce different microsecond values and violate the migration's exact-expiry invariant.

CI is expected to validate this branch. No local build or test execution is claimed.
