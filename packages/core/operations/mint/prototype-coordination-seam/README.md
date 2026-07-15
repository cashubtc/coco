# PROTOTYPE — Mint issuance coordination seam

## Question

Where should transparent batch coordination live so processor-driven and explicit execution share
capability checks, locking, persistence, and recovery without turning a Mint Batch into a public
operation or weakening the existing per-quote Mint Operation model?

This throwaway prototype tests one architectural hypothesis: a deep internal
`MintIssuanceCoordinator` sits beside `MintOperationService`. The processor offers individual ready
operations to it, while both scheduled ticks and explicit per-operation calls cross the same seam.
The coordinator alone chooses whether an internal Mint Issuance Attempt has one member or is a Mint
Batch.

```ts
interface MintIssuanceCoordinator {
  schedule(operationId: string, notBefore?: number): void;

  coordinate(): Promise<void>;
  coordinate(operationId: string): Promise<MintOperation>;
}
```

`coordinate(operationId)` is state-sensitive: a pending target dispatches immediately, a prepared
or executing target joins/reconciles its exact attempt, and a terminal target returns idempotently.
The coordinator never accepts a caller-constructed member list and is not exported from the package
root.

The prototype treats attempt creation as one atomic transaction. The exact record, repository, and
adapter schema are deliberately left to the follow-on persistence decision.

## Run

```sh
bun run prototype:mint-coordination-seam
```

Try both starting paths after a reset:

- `e` makes an explicit operation the mandatory first member and pulls scheduled compatible peers
  forward without waiting.
- `p` lets the processor trigger one deterministic scheduled chunk without knowing its members.

Then drive success, ambiguity, restart recovery, or a competing explicit caller. The full state and
module trace are rendered after every action.

## Designs compared

- Putting batch construction in `MintOperationProcessor` makes explicit calls either duplicate the
  rules or depend on a background processor that may be disabled.
- Putting it in method handlers gives transport code ownership of transactions, locks, operation
  membership, and recovery.
- Giving callers a batch or attempt interface leaks an internal atomicity boundary into the public
  per-quote model.
- A larger issuance engine with separate advance/recover commands is flexible, but no current second
  scheduling policy justifies exposing that extra interface yet.

The proposed coordinator concentrates capability gating, deterministic cohort selection, shared
locking, attempt persistence, single-versus-batch dispatch, proof attribution, fallback, and exact
recovery behind the two-entry interface above.
