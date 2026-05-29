# Extract Reusable Mint Claim Service

## Context

PR 182 should generalize reusable mint claiming inside `MintOperationService`
while rebasing BOLT12 mint onto the `feat/onchain` reusable quote primitives.
That keeps the rebase scoped to behavior and avoids adding a second refactor
axis while conflicts are still being resolved.

## Follow-up

Extract the reusable quote claiming logic into a dedicated module or service
after BOLT12 and onchain share the same semantics.

The extracted component should own:

- reusable quote capability checks;
- claimable balance calculation;
- pending sibling selection;
- auto-claim operation creation;
- quote-scoped locking boundaries, or a clearly documented dependency on the
  operation service lock.

## Acceptance Criteria

- `MintOperationService` delegates reusable quote claiming without changing
  public behavior.
- Claiming remains method-agnostic and driven by `quote.reusable`.
- The invariant stays explicit:

  ```text
  claimable = remote paid - effective issued - locally executing reservations
  ```

- Existing onchain and BOLT12 reusable claim tests still cover the extracted
  behavior.
