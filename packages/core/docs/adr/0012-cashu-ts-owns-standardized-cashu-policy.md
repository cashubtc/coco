# cashu-ts owns standardized Cashu policy

Status: accepted

cashu-ts owns pure interpretation of Cashu protocol rules, including wire validation, normalized
mint membership, payment-request method and fee calculations, mint capability matching, and fee
inclusion. Coco consumes those policy results while retaining ownership of trust decisions,
durable operations, persistence, domain semantics, and Operation Recovery; this extends ADR-0007
without allowing cashu-ts helpers to bypass Coco's operation sagas.

## Considered Options

We rejected reproducing the same NUT rules inside Coco because duplicated protocol policy drifts as
Cashu specifications and cashu-ts release candidates evolve.
